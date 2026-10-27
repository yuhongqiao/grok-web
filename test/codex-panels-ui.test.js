import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { codexFixture, waitFor } from "./codex-helpers.js";

const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => file && fs.existsSync(file));
const text = (page, value) => page.waitForFunction((text) => document.body.innerText.includes(text), { timeout: 12_000 }, value);
async function button(page, label, root = "") {
  await page.waitForFunction((label, root) => [...document.querySelectorAll(`${root ? `${root} ` : ""}button`)].some((node) => node.innerText.trim() === label && !node.disabled), { timeout: 15_000 }, label, root);
  for (const item of await page.$$(`${root ? `${root} ` : ""}button`)) if ((await item.evaluate((node) => node.innerText)).trim() === label) { await page.waitForFunction((node) => !node.disabled, { timeout: 15_000 }, item); await item.click(); return; }
  throw new Error(`Missing button: ${label}`);
}
async function menu(page, label) { await page.click("summary[aria-label='Codex 更多操作']"); await button(page, label, ".codex-menu"); }

test("session links, older turn anchors, pins, CLI resume, JSON export and completion notifications", { skip: !chrome, timeout: 45_000 }, async () => {
  const f = await codexFixture(); const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    const persisted = JSON.parse(fs.readFileSync(path.join(f.fakeHome, `${thread.id}.json`)));
    persisted.turns = Array.from({ length: 52 }, (_, index) => ({ id: `turn-${index}`, status: "completed", items: [{ id: `user-${index}`, type: "userMessage", content: [{ type: "text", text: `history input ${index}` }] }, { id: `reply-${index}`, type: "agentMessage", text: `history reply ${index}` }] }));
    fs.writeFileSync(path.join(f.fakeHome, `${thread.id}.json`), JSON.stringify(persisted)); f.codex.stop();
    const page = await browser.newPage(); const errors = []; page.on("pageerror", (error) => errors.push(String(error)));
    await page.evaluateOnNewDocument(() => { window.testNotifications = []; window.Notification = class { static permission = "granted"; static async requestPermission() { return "granted"; } constructor(title, options) { window.testNotifications.push({ title, ...options }); } }; });
    await browser.defaultBrowserContext().overridePermissions(f.base, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
    await page.goto(`${f.base}/codex#/t/${thread.id}/turn/turn-2`);
    await page.waitForSelector("[data-turn-id='turn-2'].codex-linked-turn");
    assert.equal(await page.$eval("[data-turn-id='turn-2']", (node) => node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().top < 250), true);
    await menu(page, "复制会话链接"); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${f.base}/codex#/t/${thread.id}`);
    await page.$eval("[data-turn-id='turn-2'] button[aria-label='复制 Codex 本轮链接']", (node) => node.click());
    await waitFor(async () => (await page.evaluate(() => navigator.clipboard.readText())).endsWith("/turn/turn-2"));
    await menu(page, "复制 CLI 恢复命令"); assert.match(await page.evaluate(() => navigator.clipboard.readText()), new RegExp(`codex -C .* resume '${thread.id}'`));
    await menu(page, "置顶会话"); await page.waitForFunction(() => document.querySelector("[data-testid='codex-session']")?.innerText.includes("★"));
    const downloads = path.join(f.root, "downloads"); fs.mkdirSync(downloads);
    await (await page.createCDPSession()).send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    await menu(page, "导出 JSON"); const downloaded = await waitFor(() => fs.readdirSync(downloads).find((name) => name.endsWith(".json"))); assert.equal(JSON.parse(fs.readFileSync(path.join(downloads, downloaded))).turns.length, 52);
    await menu(page, "开启完成通知");
    await page.type("[data-testid='codex-composer']", "notification test"); await page.keyboard.press("Enter");
    await waitFor(async () => (await page.evaluate(() => window.testNotifications.length)) === 1);
    await page.reload(); await text(page, "history reply 51"); assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("codex-web-pins"))).includes(thread.id), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await f.close(); }
});

test("browser panel records and replays a flow, edits native files, runs terminals/services and invokes native review", { skip: !chrome, timeout: 60_000 }, async () => {
  const f = await codexFixture(); const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  try {
    fs.writeFileSync(path.join(f.cwd, "sample.txt"), "original file");
    fs.writeFileSync(path.join(f.cwd, "package.json"), JSON.stringify({ scripts: { dev: "isolated-test-server" } }));
    const { thread } = await f.codex.create({ cwd: f.cwd });
    const page = await browser.newPage(); const errors = []; page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(`${f.base}/codex#/t/${thread.id}`); await text(page, "本地 Codex 已连接");
    await button(page, "浏览器测试", ".tabs"); await page.click("input[aria-label='测试页面地址']", { clickCount: 3 }); await page.type("input[aria-label='测试页面地址']", `${f.base}/api/health`); await button(page, "前往", ".browser-panel");
    await page.waitForSelector(".browser-preview img");
    await button(page, "开始录制", ".browser-panel"); await text(page, "取消录制");
    await page.type("input[aria-label='浏览器输入内容']", "ok"); await button(page, "断言文字存在", ".browser-panel");
    await page.type("input[aria-label='测试用例名称']", "Health smoke test"); await button(page, "保存用例", ".browser-panel"); await page.waitForSelector(".browser-panel .panel-list-row"); await page.click(".browser-panel .panel-list-row");
    await button(page, "运行测试", ".browser-panel"); await page.waitForSelector("[data-testid='codex-browser-report']"); await text(page, "Health smoke test · 通过");
    await button(page, "设为视觉基准", ".browser-panel"); await page.waitForFunction(() => ![...document.querySelectorAll(".browser-panel button")].find((node) => node.innerText === "设为视觉基准")?.disabled);
    await button(page, "手动接管登录", ".browser-panel"); await text(page, "当前由你接管"); assert.equal(await page.$eval("input[aria-label='测试页面地址'] + button", (node) => node.disabled), true); await button(page, "交回 Codex 控制", ".browser-panel");
    await page.screenshot({ path: path.join(f.root, "codex-browser-desktop.png"), fullPage: true });
    await page.setViewport({ width: 390, height: 844 }); await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 0); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(f.root, "codex-browser-mobile.png"), fullPage: true });
    await page.setViewport({ width: 1440, height: 1000 });
    await button(page, "框选标注", ".browser-panel"); const bounds = await (await page.$(".browser-preview")).boundingBox();
    await page.mouse.move(bounds.x + 20, bounds.y + 20); await page.mouse.down(); await page.mouse.move(bounds.x + 140, bounds.y + 80); await page.mouse.up();
    await page.type("input[aria-label='截图问题说明']", "检查测试标注区域"); await button(page, "发给 Codex 检查", ".browser-panel"); await text(page, "收到：请检查浏览器截图中红框标注的位置");
    assert.equal(f.codex.snapshot(thread.id).thread.turns[0].items[0].content.some((part) => part.type === "image"), true);
    await button(page, "浏览器测试", ".tabs"); await page.waitForSelector(".browser-panel .panel-list-row"); const rows = await page.$$(".browser-panel .panel-list-row"); await rows.at(-1).click();
    await button(page, "让 Codex 修复并重测", ".browser-panel"); await text(page, "收到：请根据以下浏览器测试报告修复问题");
    await button(page, "开发面板", ".tabs"); await button(page, "· sample.txt", ".workspace-tree"); await page.waitForSelector("textarea[aria-label='项目文件内容']");
    await page.click("textarea[aria-label='项目文件内容']", { clickCount: 3 }); await page.type("textarea[aria-label='项目文件内容']", "saved through native file API"); await button(page, "保存文件"); await text(page, "文件已保存"); assert.equal(fs.readFileSync(path.join(f.cwd, "sample.txt"), "utf8"), "saved through native file API");
    await page.screenshot({ path: path.join(f.root, "codex-workspace-desktop.png"), fullPage: true });
    fs.writeFileSync(path.join(f.cwd, "sample.txt"), "changed outside editor"); await page.type("textarea[aria-label='项目文件内容']", "local edit"); await button(page, "保存文件"); await text(page, "文件已被 CLI 或其他程序修改"); assert.equal(fs.readFileSync(path.join(f.cwd, "sample.txt"), "utf8"), "changed outside editor");
    await button(page, "终端", ".panel-tabs"); await button(page, "新建终端"); await page.waitForSelector("[data-testid='codex-native-terminal'] .xterm-screen"); await page.click(".xterm-screen"); await page.keyboard.type("test input"); await waitFor(() => f.workspace.list(f.cwd).processes.some((entry) => entry.output.includes("synthetic terminal input"))); await button(page, "停止进程"); await text(page, "已退出");
    await button(page, "项目服务", ".panel-tabs"); await page.select("select[aria-label='项目启动脚本']", "dev"); await button(page, "启动服务"); await text(page, "synthetic service ready"); await button(page, "停止进程");
    await button(page, "Git 与审查", ".panel-tabs"); await button(page, "开始审查"); await text(page, "原生审查完成：uncommittedChanges"); assert.equal(f.codex.snapshot(thread.id).thread.turns.length, 3);
    assert.deepEqual(errors, []); console.log(`New panel visuals: ${f.root}`);
  } finally { await browser.close(); await f.close(); }
});

test("native browser calls automatically show the embedded preview in chat and allow login takeover", { skip: !chrome, timeout: 45_000 }, async () => {
  const f = await codexFixture(); const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  let handoff;
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    const persisted = JSON.parse(fs.readFileSync(path.join(f.fakeHome, `${thread.id}.json`)));
    persisted.turns = [{ id: "browser-turn", status: "completed", items: [{ id: "browser-open", type: "mcpToolCall", server: "grok_web_browser_test", tool: "browser_open", arguments: { projectPath: f.cwd, url: `${f.base}/api/health` }, status: "completed" }, { id: "browser-fill", type: "mcpToolCall", server: "grok_web_browser_test", tool: "browser_action", arguments: { projectPath: f.cwd, action: "fill", selector: "#password", text: "secret-never-rendered-in-tools" }, status: "completed" }] }];
    fs.writeFileSync(path.join(f.fakeHome, `${thread.id}.json`), JSON.stringify(persisted)); f.codex.stop();
    await f.browserLab.tool("browser_open", { projectPath: f.cwd, url: `${f.base}/api/health` });
    const page = await browser.newPage(); const errors = []; page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(`${f.base}/codex#/t/${thread.id}`);
    await page.waitForSelector("[data-testid='codex-browser-session'] img");
    assert.equal(await page.$eval(".tabs .active", (node) => node.innerText), "对话");
    await page.$$eval("[data-testid='codex-tool']", (nodes) => nodes.forEach((node) => node.open = true));
    assert.equal((await page.$eval(".codex-scroll", (node) => node.innerText)).includes("secret-never-rendered-in-tools"), false);
    handoff = f.browserLab.tool("browser_handoff", { projectPath: f.cwd, reason: "请完成测试登录" });
    await text(page, "请完成测试登录");
    const login = await f.browserLab.state(f.cwd, "default");
    assert.equal(login.manual, true);
    await page.type("input[aria-label='接管浏览器输入']", "temporary-input");
    await button(page, "输入到页面", ".codex-browser-session");
    await page.waitForFunction(() => document.querySelector("input[aria-label='接管浏览器输入']").value === "");
    await button(page, "完成登录，继续", ".codex-browser-session");
    assert.equal(JSON.parse((await handoff).content[0].text).manual, false);
    await page.screenshot({ path: path.join(f.root, "embedded-browser-desktop.png") });
    await page.setViewport({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector(".sidebar").getBoundingClientRect().right <= 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(f.root, "embedded-browser-mobile.png") });
    await page.click("button[aria-label='收起内置浏览器']");
    assert.equal(Boolean(await page.$(".codex-browser-session.collapsed")), true);
    assert.deepEqual(errors, []);
    console.log(`Embedded browser visuals: ${f.root}`);
  } finally { await browser.close(); await f.close(); await handoff?.catch(() => {}); }
});
