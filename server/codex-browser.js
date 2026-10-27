import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import puppeteer from "puppeteer-core";
import { PNG } from "pngjs";
import { HttpError } from "./sessions.js";
import { workspaceRoot } from "./codex-workspace.js";

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const chromePath = () => [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((file) => file && fs.existsSync(file));
const cleanUrl = (value) => { try { const url = new URL(value); url.hash = ""; for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "…"); return url.toString(); } catch { return value; } };
const jsonRead = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } };
const jsonWrite = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); };

export const browserTools = [
  { name: "browser_open", description: "Open the browser embedded in the user's Codex Web conversation. Use this when asked to use a browser to log in, test a website, or verify a page: open the URL, read browser_snapshot, operate with browser_action, then verify the result. The user automatically sees your browser. Reuses a separate persistent login profile, never the user's personal Chrome profile. Pass the current session project directory as projectPath.", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, profile: { type: "string" }, url: { type: "string" } }, required: ["projectPath"] } },
  { name: "browser_snapshot", description: "Read the current page, element refs, tabs and diagnostics. Password values, cookies and auth headers are not returned.", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, profile: { type: "string" } }, required: ["projectPath"] } },
  { name: "browser_action", description: "Operate the embedded browser using refs from browser_snapshot: navigate, click, fill, type, press, select, scroll, wait, assert, viewport, back, forward, reload, tab, newTab, closeTab. assert supports text, selector or url. Complete the requested login and page tests, checking the resulting page rather than merely opening it. For login verification/captcha or missing credentials use browser_handoff. Do not work around manual takeover.", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, profile: { type: "string" }, action: { type: "string" }, url: { type: "string" }, ref: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, key: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "integer" }, height: { type: "integer" }, tab: { type: "integer" } }, required: ["projectPath", "action"] } },
  { name: "browser_handoff", description: "Ask the user to complete login, captcha or verification directly in the embedded browser, then wait up to five minutes. The tool resumes with the updated page when the user clicks 完成登录，继续. Never request a password in chat when the user can enter it here. If the wait expires, stop browser actions and ask the user to return control before continuing.", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, profile: { type: "string" }, reason: { type: "string" } }, required: ["projectPath", "reason"] } },
  { name: "browser_screenshot", description: "Capture the current test browser viewport as an image.", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, profile: { type: "string" } }, required: ["projectPath"] } },
  { name: "browser_tests", description: "List saved browser test cases and reports, or run a saved case to verify changes. Supply secret variables only at runtime; they are not saved to reports. After fixing a reported bug, rerun its case and check the result.", inputSchema: { type: "object", properties: { projectPath: { type: "string" }, profile: { type: "string" }, action: { type: "string", enum: ["list", "run"] }, caseId: { type: "string" }, variables: { type: "object", additionalProperties: { type: "string" } } }, required: ["projectPath", "action"] } },
];

export function createBrowserLab({ dataDir, headless = true, executablePath = chromePath() }) {
  const sessions = new Map();
  let stopping = false;

  function session(cwd, profile = "default") {
    const root = workspaceRoot(cwd);
    if (typeof profile !== "string" || !profile.trim() || profile.length > 60) throw new HttpError(400, "浏览器配置名称须为 1–60 个字符");
    profile = profile.trim();
    const id = hash(`${root}\0${profile}`);
    if (!sessions.has(id)) {
      const dir = path.join(dataDir, id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      jsonWrite(path.join(dir, "profile.json"), { cwd: root, profile });
      sessions.set(id, { id, cwd: root, profile, dir, browser: null, launching: null, page: null, chain: Promise.resolve(), manual: false, recording: null, running: false, console: [], network: [], secrets: new Set() });
    }
    return sessions.get(id);
  }

  function redact(s, text) {
    let result = String(text);
    for (const secret of s.secrets) if (secret) result = result.split(secret).join("[已隐藏]");
    return result;
  }

  function observe(s, page) {
    page.setDefaultTimeout(10_000);
    page.on("console", (message) => { s.console.push({ time: Date.now(), type: message.type(), text: redact(s, message.text()).slice(0, 4000) }); if (s.console.length > 150) s.console.shift(); });
    page.on("pageerror", (error) => { s.console.push({ time: Date.now(), type: "error", text: redact(s, error.message).slice(0, 4000) }); if (s.console.length > 150) s.console.shift(); });
    page.on("response", (response) => { const request = response.request(); s.network.push({ time: Date.now(), method: request.method(), url: cleanUrl(request.url()), status: response.status() }); if (s.network.length > 150) s.network.shift(); });
    page.on("requestfailed", (request) => { s.network.push({ time: Date.now(), method: request.method(), url: cleanUrl(request.url()), error: request.failure()?.errorText }); if (s.network.length > 150) s.network.shift(); });
  }

  async function launch(s) {
    if (stopping) throw new HttpError(503, "浏览器服务正在关闭");
    if (s.browser?.connected) return;
    if (!s.launching) s.launching = (async () => {
      if (!executablePath) throw new HttpError(503, "未找到 Chrome，请安装 Chrome 或设置 CHROME_BIN");
      const browser = await puppeteer.launch({ executablePath, headless, userDataDir: path.join(s.dir, "chrome"), defaultViewport: { width: 1280, height: 800 }, args: ["--no-first-run", "--no-default-browser-check", ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
      s.browser = browser;
      for (const page of await browser.pages()) observe(s, page);
      browser.on("targetcreated", async (target) => { try { if (target.type() === "page") { const page = await target.page(); if (page && !page.isClosed()) observe(s, page); } } catch {} });
      browser.on("disconnected", () => { s.browser = null; s.page = null; s.manual = false; s.handoff?.reject(new HttpError(409, "浏览器已关闭，请重新打开后继续")); });
      s.page = (await browser.pages())[0] || await browser.newPage();
    })().finally(() => { s.launching = null; });
    await s.launching;
  }

  async function pageFor(s) {
    await launch(s);
    if (!s.page || s.page.isClosed()) s.page = (await s.browser.pages()).find((page) => !page.isClosed()) || await s.browser.newPage();
    return s.page;
  }

  function serial(s, operation) {
    const result = s.chain.then(operation);
    s.chain = result.catch(() => {});
    return result;
  }

  async function snapshot(s, withImage = true) {
    if (!s.browser?.connected) return { opened: false, profile: s.profile, manual: false, recording: Boolean(s.recording), running: s.running };
    const page = await pageFor(s);
    let content;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        content = await page.evaluate(() => {
          const selector = (element) => {
            if (element.id) return `#${CSS.escape(element.id)}`;
            if (element.getAttribute("data-testid")) return `[data-testid=${JSON.stringify(element.getAttribute("data-testid"))}]`;
            if (element.getAttribute("name")) return `${element.tagName.toLowerCase()}[name=${JSON.stringify(element.getAttribute("name"))}]`;
            const parts = []; let node = element;
            while (node && node !== document.body && parts.length < 7) { const tag = node.tagName.toLowerCase(); const peers = [...node.parentElement.children].filter((entry) => entry.tagName === node.tagName); parts.unshift(`${tag}:nth-of-type(${peers.indexOf(node) + 1})`); node = node.parentElement; }
            return `body > ${parts.join(" > ")}`;
          };
          const elements = [...document.querySelectorAll("a,button,input,textarea,select,[role=button],[contenteditable=true]")].filter((element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden"; }).slice(0, 160).map((element, index) => {
            const ref = String(index + 1); element.setAttribute("data-codex-web-ref", ref);
            return { ref, selector: selector(element), tag: element.tagName.toLowerCase(), type: element.getAttribute("type") || "", label: (element.getAttribute("aria-label") || element.labels?.[0]?.innerText || element.innerText || element.getAttribute("placeholder") || element.getAttribute("name") || "").slice(0, 180), disabled: Boolean(element.disabled) };
          });
          return { title: document.title, text: document.body?.innerText.slice(0, 16000) || "", elements };
        });
        break;
      } catch (error) { if (attempt || page.isClosed()) throw error; await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => {}); }
    }
    const tabs = await s.browser.pages();
    content.text = redact(s, content.text);
    content.title = redact(s, content.title);
    content.elements = content.elements.map((entry) => ({ ...entry, label: redact(s, entry.label) }));
    return { opened: true, profile: s.profile, manual: s.manual, handoffReason: s.handoffReason || "", recording: Boolean(s.recording), running: s.running, url: redact(s, page.url()), ...content, viewport: page.viewport(), tabs: await Promise.all(tabs.map(async (tab, index) => ({ index, title: redact(s, await tab.title().catch(() => "")), url: cleanUrl(tab.url()), active: tab === page }))), console: s.console.map((entry) => ({ ...entry, text: redact(s, entry.text) })), network: s.network, ...(withImage ? { image: Buffer.from(await page.screenshot({ type: "png", waitForFonts: false, timeout: 10_000 })).toString("base64") } : {}) };
  }

  function navigateUrl(value) {
    let url; try { url = new URL(value); } catch { throw new HttpError(400, "请输入完整的 http:// 或 https:// 地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new HttpError(400, "测试浏览器仅打开不含内嵌账号密码的 HTTP(S) 地址");
    return url.toString();
  }

  async function perform(s, step, replay = false, manual = false) {
    if (s.manual && !manual) throw new HttpError(409, "浏览器正在由用户接管，请等待用户交回控制权");
    const page = await pageFor(s);
    const recorded = { ...step };
    delete recorded.cwd; delete recorded.profile; delete recorded.projectPath;
    let selector = step.selector;
    if (step.ref) selector = `[data-codex-web-ref=${JSON.stringify(String(step.ref))}]`;
    let element;
    if (selector && ["click", "fill", "select", "press"].includes(step.action)) {
      element = await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
      const info = await element.evaluate((element) => {
        const name = element.getAttribute("name");
        return { secret: element.type === "password", stable: element.id ? `#${CSS.escape(element.id)}` : name ? `${element.tagName.toLowerCase()}[name=${JSON.stringify(name)}]` : null };
      });
      recorded.selector = info.stable || (await snapshot(s, false)).elements.find((entry) => entry.ref === String(step.ref))?.selector || selector;
      delete recorded.ref;
      if (info.secret && typeof step.text === "string") {
        s.secrets.add(step.text);
        if (!replay) recorded.text = `{{secret_${(s.recording?.steps.filter((entry) => entry.secret).length || 0) + 1}}}`;
        recorded.secret = true;
      }
    }
    if (step.action === "navigate") await page.goto(navigateUrl(step.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
    else if (step.action === "click") {
      if (element) {
        const navigates = await element.evaluate((node) => Boolean(node.closest("a[href],button[type=submit],form button:not([type]),input[type=submit]")));
        const navigation = navigates ? page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => {}) : null;
        await element.click();
        if (navigation) await navigation;
      }
      else if (Number.isFinite(step.x) && Number.isFinite(step.y)) {
        const target = await page.evaluate((x, y) => { const element = document.elementFromPoint(x, y)?.closest("a,button,input,textarea,select,[role=button]"); return element?.getAttribute("data-codex-web-ref"); }, step.x, step.y);
        const stable = target && (await snapshot(s, false)).elements.find((entry) => entry.ref === target)?.selector;
        if (stable) { recorded.selector = stable; delete recorded.x; delete recorded.y; }
        const navigates = await page.evaluate((x, y) => Boolean(document.elementFromPoint(x, y)?.closest("a[href],button[type=submit],form button:not([type]),input[type=submit]")), step.x, step.y);
        const navigation = navigates ? page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => {}) : null;
        await page.mouse.click(step.x, step.y);
        if (navigation) await navigation;
      } else throw new HttpError(400, "请指定元素或点击位置");
    } else if (step.action === "fill") {
      if (!element || typeof step.text !== "string") throw new HttpError(400, "请指定输入框及内容");
      await element.click({ clickCount: 3 });
      await element.evaluate((element) => element.select?.());
      await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
      await page.keyboard.press("A");
      await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
      await page.keyboard.sendCharacter(step.text);
    } else if (step.action === "type") {
      if (typeof step.text !== "string") throw new HttpError(400, "请输入文字");
      const secret = await page.evaluate(() => document.activeElement?.type === "password");
      if (secret) { s.secrets.add(step.text); recorded.secret = true; if (!replay) recorded.text = `{{secret_${(s.recording?.steps.filter((entry) => entry.secret).length || 0) + 1}}}`; }
      await page.keyboard.sendCharacter(step.text);
    } else if (step.action === "press") {
      if (element) await element.focus();
      const navigates = (step.key || "Enter") === "Enter" && await page.evaluate(() => Boolean(document.activeElement?.closest("form")));
      const navigation = navigates ? page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => {}) : null;
      await page.keyboard.press(String(step.key || "Enter"));
      if (navigation) await navigation;
    }
    else if (step.action === "select") { if (!element) throw new HttpError(400, "请选择下拉框"); await element.select(String(step.text)); }
    else if (step.action === "scroll") await page.mouse.wheel({ deltaY: Number(step.y) || 600, deltaX: Number(step.x) || 0 });
    else if (step.action === "wait" || step.action === "assert") {
      if (!step.text && !step.selector && !step.url) throw new HttpError(400, "请填写要验证的文字、元素或网址");
      await page.waitForFunction(({ text, selector, url }) => (!text || document.body?.innerText.includes(text)) && (!selector || Boolean(document.querySelector(selector))) && (!url || location.href.includes(url)), { timeout: step.action === "assert" ? 5000 : 15_000 }, { text: step.text, selector: step.selector, url: step.url });
    } else if (step.action === "viewport") {
      if (![step.width, step.height].every((value) => Number.isInteger(value) && value >= 240 && value <= 2560)) throw new HttpError(400, "视口尺寸须在 240–2560 之间");
      await page.setViewport({ width: step.width, height: step.height });
    } else if (step.action === "back") await page.goBack({ waitUntil: "domcontentloaded" });
    else if (step.action === "forward") await page.goForward({ waitUntil: "domcontentloaded" });
    else if (step.action === "reload") await page.reload({ waitUntil: "domcontentloaded" });
    else if (step.action === "newTab") { s.page = await s.browser.newPage(); if (step.url) await s.page.goto(navigateUrl(step.url), { waitUntil: "domcontentloaded" }); }
    else if (step.action === "tab") { const tabs = await s.browser.pages(); if (!tabs[step.tab]) throw new HttpError(400, "找不到该标签页"); s.page = tabs[step.tab]; await s.page.bringToFront(); }
    else if (step.action === "closeTab") { await page.close(); s.page = null; await pageFor(s); }
    else throw new HttpError(400, "不支持的浏览器操作");
    if (s.recording && !replay && !manual) s.recording.steps.push(recorded);
    return snapshot(s);
  }

  const casesFile = (s) => path.join(s.dir, "cases.json");
  const caseList = (s) => jsonRead(casesFile(s), []);
  const reportDir = (s) => path.join(s.dir, "reports");
  function reports(s) {
    if (!fs.existsSync(reportDir(s))) return [];
    return fs.readdirSync(reportDir(s)).filter((id) => /^[a-f0-9-]{36}$/.test(id)).map((id) => jsonRead(path.join(reportDir(s), id, "report.json"), null)).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt).slice(0, 50);
  }

  async function run(s, id, variables = {}) {
    if (s.manual || s.running || s.recording) throw new HttpError(409, "请先交回控制权、停止录制或等待当前测试完成");
    const selected = caseList(s).find((entry) => entry.id === id);
    if (!selected) throw new HttpError(404, "找不到测试用例");
    if (!variables || typeof variables !== "object" || Array.isArray(variables) || Object.values(variables).some((value) => typeof value !== "string")) throw new HttpError(400, "运行变量必须是文本");
    for (const step of selected.steps) for (const match of String(step.text || "").matchAll(/\{\{(\w+)\}\}/g)) if (!Object.hasOwn(variables, match[1])) throw new HttpError(400, `请填写运行变量 ${match[1]}，变量仅用于本次运行`);
    for (const value of Object.values(variables)) if (typeof value === "string") s.secrets.add(value);
    const report = { id: randomUUID(), caseId: id, name: selected.name, startedAt: Date.now(), status: "running", profile: s.profile, steps: [], console: [], network: [] };
    const dir = path.join(reportDir(s), report.id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    s.running = true;
    try {
      for (const [index, step] of selected.steps.entries()) {
        const start = Date.now(); const result = { index, action: step.action, selector: step.selector, text: step.secret ? "[运行时密钥]" : redact(s, step.text || ""), status: "passed" };
        try {
          const input = { ...step, text: typeof step.text === "string" ? step.text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key]) : step.text };
          const state = await perform(s, input, true);
          fs.writeFileSync(path.join(dir, `${index}.png`), Buffer.from(state.image, "base64"), { mode: 0o600 });
          result.screenshot = `${index}.png`;
        } catch (error) {
          result.status = "failed"; result.error = redact(s, error.message);
          const page = await pageFor(s).catch(() => null);
          if (page) { await page.screenshot({ path: path.join(dir, `${index}.png`), waitForFonts: false, timeout: 10_000 }).catch(() => {}); if (fs.existsSync(path.join(dir, `${index}.png`))) result.screenshot = `${index}.png`; }
        }
        result.durationMs = Date.now() - start; report.steps.push(result);
        if (result.status === "failed") break;
      }
      report.status = report.steps.length === selected.steps.length && report.steps.every((step) => step.status === "passed") ? "passed" : "failed";
      const last = report.steps.at(-1);
      const baseline = path.join(s.dir, "baselines", `${id}.png`);
      if (last?.screenshot && fs.existsSync(baseline)) {
        const a = PNG.sync.read(fs.readFileSync(baseline)); const b = PNG.sync.read(fs.readFileSync(path.join(dir, last.screenshot)));
        let changed = a.width * a.height;
        if (a.width === b.width && a.height === b.height) { changed = 0; for (let offset = 0; offset < a.data.length; offset += 4) if ([0, 1, 2].some((channel) => Math.abs(a.data[offset + channel] - b.data[offset + channel]) > 20)) changed++; }
        report.visual = { changedPixels: changed, totalPixels: a.width * a.height, percent: Number((changed / (a.width * a.height) * 100).toFixed(2)), sameSize: a.width === b.width && a.height === b.height };
      }
    } catch (error) {
      report.status = "failed";
      report.error = redact(s, error.message);
    } finally {
      report.finishedAt = Date.now();
      report.console = s.console.filter((entry) => entry.time >= report.startedAt).map((entry) => ({ ...entry, text: redact(s, entry.text) }));
      report.network = s.network.filter((entry) => entry.time >= report.startedAt);
      s.running = false;
      jsonWrite(path.join(dir, "report.json"), report);
    }
    return report;
  }

  const lab = {
    async state(cwd, profile, withImage = true) { const s = session(cwd, profile); return serial(s, () => snapshot(s, withImage)); },
    async profiles(cwd) {
      const root = workspaceRoot(cwd); fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const entries = fs.readdirSync(dataDir).filter((name) => /^[a-f0-9]{24}$/.test(name)).map((name) => jsonRead(path.join(dataDir, name, "profile.json"), null)).filter((entry) => entry?.cwd === root);
      return { profiles: [...new Set(["default", ...entries.map((entry) => entry.profile)])] };
    },
    async open(cwd, profile, url) { const s = session(cwd, profile); return serial(s, async () => { await launch(s); if (url) return perform(s, { action: "navigate", url }); return snapshot(s); }); },
    async action(cwd, profile, body) { const s = session(cwd, profile); if (s.running) throw new HttpError(409, "测试用例正在运行"); return serial(s, () => perform(s, body)); },
    async interact(cwd, profile, body) {
      const s = session(cwd, profile);
      return serial(s, () => {
        if (!s.manual) throw new HttpError(409, "请先接管浏览器");
        if (!["click", "fill", "type", "press", "select", "scroll", "tab"].includes(body.action)) throw new HttpError(400, "不支持的接管操作");
        return perform(s, body, false, true);
      });
    },
    async manual(cwd, profile, value) {
      const s = session(cwd, profile);
      if (typeof value !== "boolean") throw new HttpError(400, "接管状态无效");
      return serial(s, async () => {
        if (value) { const page = await pageFor(s); await page.bringToFront(); }
        s.manual = value;
        if (!value) { s.handoffReason = ""; s.handoff?.resolve(); }
        return { manual: s.manual };
      });
    },
    async handoff(cwd, profile, reason) {
      const s = session(cwd, profile);
      let waiting;
      await serial(s, async () => {
        if (s.handoff) throw new HttpError(409, "正在等待用户完成登录");
        await pageFor(s);
        s.manual = true;
        s.handoffReason = String(reason || "请在内置浏览器中完成登录或验证").slice(0, 500);
        waiting = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new HttpError(408, "等待登录超时。浏览器仍由用户接管，请等待用户交回控制权后继续。")), 300_000);
          s.handoff = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } };
        });
      });
      try {
        await waiting;
        return await this.state(cwd, profile, false);
      } finally { s.handoff = null; }
    },
    async close(cwd, profile) { const s = session(cwd, profile); if (s.running || s.pendingRun) throw new HttpError(409, "请等待测试结束"); return serial(s, async () => { await s.browser?.close(); s.recording = null; return { ok: true }; }); },
    async recording(cwd, profile, action, name) {
      const s = session(cwd, profile);
      return serial(s, async () => {
        if (s.running) throw new HttpError(409, "测试正在运行");
        if (action === "start") { const page = await pageFor(s); s.recording = { steps: /^https?:/.test(page.url()) ? [{ action: "navigate", url: page.url() }] : [] }; return { recording: true }; }
        if (action === "save") {
          if (!s.recording?.steps.length) throw new HttpError(400, "请先录制至少一个操作");
          if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "请输入用例名称");
          const entry = { id: randomUUID(), name: name.trim().slice(0, 100), steps: s.recording.steps, createdAt: Date.now() };
          jsonWrite(casesFile(s), [...caseList(s), entry]); s.recording = null; return entry;
        }
        if (action === "cancel") { s.recording = null; return { recording: false }; }
        throw new HttpError(400, "不支持的录制操作");
      });
    },
    list(cwd, profile) { const s = session(cwd, profile); return { cases: caseList(s), reports: reports(s), recording: Boolean(s.recording), running: s.running }; },
    async run(cwd, profile, id, variables) {
      const s = session(cwd, profile);
      if (s.running || s.pendingRun) throw new HttpError(409, "测试用例正在运行");
      s.pendingRun = true;
      try { return await serial(s, () => run(s, id, variables)); } finally { s.pendingRun = false; }
    },
    baseline(cwd, profile, reportId) {
      const s = session(cwd, profile); const report = reports(s).find((entry) => entry.id === reportId);
      const image = report?.steps.at(-1)?.screenshot;
      if (report?.status !== "passed" || !image) throw new HttpError(400, "请选择已通过测试的最终截图作为基准");
      const target = path.join(s.dir, "baselines", `${report.caseId}.png`); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(path.join(reportDir(s), report.id, image), target);
      return { ok: true };
    },
    artifact(cwd, profile, reportId, file) {
      const s = session(cwd, profile);
      if (!/^[a-f0-9-]{36}$/.test(reportId) || !/^(report\.json|\d+\.png)$/.test(file)) throw new HttpError(400, "报告路径无效");
      const target = path.join(reportDir(s), reportId, file);
      if (!fs.existsSync(target)) throw new HttpError(404, "找不到报告文件");
      return { bytes: fs.readFileSync(target), mime: file.endsWith(".png") ? "image/png" : "application/json" };
    },
    async tool(name, args) {
      const cwd = args.projectPath; const profile = args.profile || "default";
      if (name === "browser_screenshot") { const state = await this.state(cwd, profile); if (!state.image) throw new HttpError(409, "请先打开浏览器"); return { content: [{ type: "image", data: state.image, mimeType: "image/png" }] }; }
      let value;
      if (name === "browser_open") value = await this.open(cwd, profile, args.url);
      else if (name === "browser_handoff") value = await this.handoff(cwd, profile, args.reason);
      else if (name === "browser_snapshot") value = await this.state(cwd, profile, false);
      else if (name === "browser_action") value = await this.action(cwd, profile, args);
      else if (name === "browser_tests") value = args.action === "run" ? await this.run(cwd, profile, args.caseId, args.variables) : this.list(cwd, profile);
      else throw new HttpError(400, "未知浏览器工具");
      const { image, ...text } = value;
      return { content: [{ type: "text", text: JSON.stringify(text) }] };
    },
    async stop() { stopping = true; await Promise.allSettled([...sessions.values()].map(async (s) => { s.handoff?.reject(new HttpError(503, "浏览器服务正在关闭")); if (s.launching) await s.launching.catch(() => {}); await s.browser?.close(); })); },
  };
  return lab;
}

export function mountBrowserRoutes(app, lab, route, token) {
  const base = "/api/codex/browser";
  app.post(`${base}/mcp`, route(async (req) => {
    if (!token || req.headers.authorization !== `Bearer ${token}`) throw new HttpError(403, "浏览器工具连接无效");
    return lab.tool(req.body.name, req.body.arguments || {});
  }));
  app.get(`${base}/state`, route((req) => lab.state(req.query.cwd, req.query.profile)));
  app.get(`${base}/profiles`, route((req) => lab.profiles(req.query.cwd)));
  app.post(`${base}/open`, route((req) => lab.open(req.body.cwd, req.body.profile, req.body.url)));
  app.post(`${base}/action`, route((req) => lab.action(req.body.cwd, req.body.profile, req.body)));
  app.post(`${base}/interact`, route((req) => lab.interact(req.body.cwd, req.body.profile, req.body)));
  app.post(`${base}/manual`, route((req) => lab.manual(req.body.cwd, req.body.profile, req.body.manual)));
  app.post(`${base}/close`, route((req) => lab.close(req.body.cwd, req.body.profile)));
  app.post(`${base}/recording`, route((req) => lab.recording(req.body.cwd, req.body.profile, req.body.action, req.body.name)));
  app.get(`${base}/tests`, route((req) => lab.list(req.query.cwd, req.query.profile)));
  app.post(`${base}/tests/:id/run`, route((req) => lab.run(req.body.cwd, req.body.profile, req.params.id, req.body.variables)));
  app.post(`${base}/reports/:id/baseline`, route((req) => lab.baseline(req.body.cwd, req.body.profile, req.params.id)));
  app.get(`${base}/reports/:id/:file`, route((req, res) => {
    const artifact = lab.artifact(req.query.cwd, req.query.profile, req.params.id, req.params.file);
    res.set({ "content-type": artifact.mime, "cache-control": "no-store", "x-content-type-options": "nosniff" }).send(artifact.bytes);
  }));
}
