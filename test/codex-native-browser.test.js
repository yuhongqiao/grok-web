import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import puppeteer from "puppeteer-core";
import { createApp } from "../server/index.js";
import { createCodexHub } from "../server/codex.js";
import { createBrowserLab } from "../server/codex-browser.js";
import { listen, storeFor, tempRoot } from "./helpers.js";
import { waitFor } from "./codex-helpers.js";
import { isBrowserCall } from "../client/src/codex/browser.js";

const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => file && fs.existsSync(file));

test("natural language login test uses native CLI tools and automatically opens the embedded browser in chat", { skip: !process.env.CODEX_NATIVE_BROWSER_TEST || !chrome, timeout: 240_000 }, async () => {
  const root = tempRoot();
  const configFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  const digest = () => fs.existsSync(configFile) ? createHash("sha256").update(fs.readFileSync(configFile)).digest("hex") : "missing";
  const before = digest();
  const marker = `VERIFIED_${randomBytes(4).toString("hex")}`;
  let logins = 0; let clicks = 0;
  const site = express(); site.use(express.urlencoded({ extended: false }));
  site.get("/", (req, res) => res.send(req.headers.cookie?.includes("test_login=yes")
    ? `<h1>测试工作台</h1><button id="check" onclick="fetch('/check',{method:'POST'}).then(r=>r.text()).then(t=>document.querySelector('#result').textContent=t)">运行检查</button><p id="result">尚未检查</p>`
    : '<h1>登录测试站点</h1><form action="/login" method="post"><label>账号<input id="username" name="username"></label><label>密码<input id="password" type="password" name="password"></label><button>登录</button></form>'));
  site.post("/login", (req, res) => { if (req.body.username !== "demo" || req.body.password !== "test-login-only") return res.status(401).send("账号或密码错误"); logins++; res.cookie("test_login", "yes", { httpOnly: true }); res.redirect("/"); });
  site.post("/check", (req, res) => { if (!req.headers.cookie?.includes("test_login=yes")) return res.sendStatus(401); clicks++; res.send(`检查通过 ${marker}`); });
  const target = await listen(site);
  const codex = createCodexHub({ projectsFile: path.join(root, "codex-projects.json") });
  codex.watchAgent((event) => { if (["item/started", "item/completed"].includes(event.method) && event.params.item.type === "mcpToolCall") console.log(`Native tool ${event.params.item.server}/${event.params.item.tool}: ${event.params.item.status}`); });
  const lab = createBrowserLab({ dataDir: path.join(root, "browser"), executablePath: chrome });
  const token = randomBytes(32).toString("hex");
  const ui = await listen(createApp({ store: storeFor(root), hub: {}, codex, browser: lab, browserToken: token }));
  codex.configureBrowser({ name: `grok_web_browser_native_${process.pid}`, script: fileURLToPath(new URL("../server/browser-mcp.js", import.meta.url)), url: `http://127.0.0.1:${ui.port}/api/codex/browser/mcp`, token });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  let id;
  try {
    const { thread } = await codex.create({ cwd: root }); id = thread.id;
    const page = await browser.newPage(); const errors = []; page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewport({ width: 1480, height: 1000 });
    await page.goto(`http://127.0.0.1:${ui.port}/codex#/t/${id}`);
    await page.waitForSelector("[data-testid='codex-composer']:not([disabled])");
    const prompt = `请用浏览器登录并测试 http://127.0.0.1:${target.port}/ ，这是本地隔离测试站点，账号 demo，密码 test-login-only。登录后点击“运行检查”，检查页面确实显示检查通过及其验证标记，并报告结果。只做浏览器测试，无需改文件。`;
    await page.type("[data-testid='codex-composer']", prompt);
    await page.waitForSelector(".codex-send:not([disabled])");
    await page.keyboard.press("Enter");
    await waitFor(async () => {
      const error = await page.$eval(".main", (node) => [...node.querySelectorAll("[role=alert]")].map((entry) => entry.innerText).join("\n"));
      assert.equal(error, "");
      return codex.snapshot(id).thread.turns.length > 0;
    }, 15_000);
    await waitFor(async () => {
      for (const request of codex.snapshot(id).interactions) {
        assert.equal(request.params.serverName, `grok_web_browser_native_${process.pid}`, "Only this test browser may be approved");
        assert.equal(request.params._meta?.codex_approval_kind, "mcp_tool_call");
        assert.equal(request.params._meta.tool_params.projectPath, root);
        await page.waitForSelector(".codex-interaction .btn.primary:not([disabled])");
        await page.click(".codex-interaction .btn.primary");
        await waitFor(() => !codex.snapshot(id).interactions.some((entry) => entry.id === request.id));
      }
      return !codex.snapshot(id).busy;
    }, 200_000);
    const turns = codex.snapshot(id).thread.turns;
    assert.equal(turns[0].items.find((item) => item.type === "userMessage").content[0].text, prompt);
    const calls = turns.flatMap((turn) => turn.items).filter(isBrowserCall);
    console.log(`Natural language browser tools: ${calls.map((item) => `${item.tool}:${item.arguments?.action || ""}:${item.status}`).join(", ")}`);
    assert.ok(calls.some((item) => item.tool === "browser_open"), JSON.stringify(turns));
    assert.ok(calls.some((item) => item.tool === "browser_action" && item.arguments.action === "click"));
    assert.ok(logins >= 1, "The real login form must have been submitted");
    assert.ok(clicks >= 1, "The authenticated page must have been tested");
    const last = calls.at(-1);
    const state = await lab.state(last.arguments.projectPath, last.arguments.profile || "default");
    assert.match(state.text, new RegExp(marker));
    assert.equal(turns.at(-1).status, "completed");
    await page.waitForSelector("[data-testid='codex-browser-session'] img");
    assert.equal(await page.$eval(".tabs .active", (node) => node.innerText), "对话");
    await (await page.$(".main")).screenshot({ path: path.join(root, "native-conversation-browser.png") });
    assert.deepEqual(errors, []);
    assert.equal(digest(), before);
    console.log(`Real CLI natural language browser verification: ${root}`);
  } finally {
    if (id) {
      if (codex.snapshot(id).busy) { await codex.cancel(id).catch(() => {}); await waitFor(() => !codex.snapshot(id).busy, 10_000).catch(() => {}); }
      await codex.archive(id).catch(() => {});
    }
    await browser.close(); await codex.state().catch(() => {}); codex.stop(); await lab.stop();
    ui.server.closeAllConnections?.(); target.server.closeAllConnections?.();
    await Promise.all([new Promise((resolve) => ui.server.close(resolve)), new Promise((resolve) => target.server.close(resolve))]);
    assert.equal(digest(), before);
  }
});
