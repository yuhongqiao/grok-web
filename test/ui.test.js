import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { fixtureApp, line, listen, tempRoot, writeSession } from "./helpers.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((candidate) => fs.existsSync(candidate));
const built = fs.existsSync(path.join(rootDir, "client", "dist", "index.html"));

const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, value, timeout = 10_000) => page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout }, value);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(page, value) {
  await page.click("[data-testid='composer']");
  await page.type("[data-testid='composer']", value);
  await page.keyboard.press("Enter");
}

async function inViewport(page, selector) {
  return page.$eval(selector, (element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth;
  });
}

test("the browser drives a whole Grok session", { skip: !chrome || !built, timeout: 180_000 }, async () => {
  const root = tempRoot();
  const { app, hub, store } = fixtureApp(root);
  const cwd = path.join(root, "projects", "短视频");
  fs.mkdirSync(cwd, { recursive: true });
  writeSession(store.sessionsDir, cwd, "01a16e75-d656-7ee2-a8dd-1ebfba4b3272", {
    title: "改稿",
    updates: [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "改一版" }, _meta: { promptIndex: 0 } }),
      line({ sessionUpdate: "tool_call", toolCallId: "c1", title: "run_terminal_command", rawInput: { command: "ls -la" }, _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } } }),
      line({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "a.txt" } }] }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "改好了，**两处**。" } }),
      line({ sessionUpdate: "turn_completed", stop_reason: "end_turn", elapsed_ms: 65_000, usage: { totalTokens: 4200 } }),
    ],
  });
  const { server, port } = await listen(app);
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 820 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });

    // An existing session opens from the sidebar and renders from disk. The newest project starts unfolded.
    await page.waitForSelector("[data-project-name='短视频']");
    await page.waitForSelector("[data-session-id='01a16e75-d656-7ee2-a8dd-1ebfba4b3272']");
    await page.click("[data-session-id='01a16e75-d656-7ee2-a8dd-1ebfba4b3272']");
    await waitText(page, "改好了，两处。");
    assert.match(await text(page), /执行命令|\$ ls -la/);
    assert.match(await text(page), /用时 1分05秒/);
    assert.equal(await page.$eval("[data-testid='model-control']", (element) => element.textContent), "grok-4.7");
    assert.equal(await page.$eval("[data-testid='effort-control']", (element) => element.textContent), "高");

    // New session: the picker chooses the project first.
    await page.click("[data-testid='new-chat']");
    await page.waitForSelector("[data-testid='project-picker'] [data-project-name='短视频']");
    await page.click("[data-testid='project-picker'] [data-project-name='短视频']");
    await page.waitForSelector("[data-testid='draft-project']");
    assert.match(await page.$eval("[data-testid='draft-project']", (element) => element.textContent), /短视频/);

    // Draft settings: menus open upward, fully visible, and apply to the first message.
    await page.click("[data-testid='effort-control']");
    await page.waitForSelector("[data-testid='effort-control-menu']");
    assert.equal(await inViewport(page, "[data-testid='effort-control-menu']"), true);
    assert.equal((await page.$$("[data-testid='effort-control-menu'] .menu-item")).length, 4);
    await page.click("[data-testid='effort-low']");
    assert.equal(await page.$eval("[data-testid='effort-control']", (element) => element.textContent), "低");
    await page.click("[data-testid='mode-control']");
    assert.equal(await inViewport(page, "[data-testid='mode-control-menu']"), true);
    await page.click("[data-testid='mode-ask']");

    await send(page, "你好");
    await waitText(page, "收到：你好");
    await page.waitForFunction(() => window.location.hash.startsWith("#/s/"));
    const sessionId = await page.evaluate(() => window.location.hash.slice(4));
    assert.equal(await page.$eval("[data-testid='effort-control']", (element) => element.textContent), "低");
    await page.waitForSelector(`[data-session-id='${sessionId}']`);

    // Several messages while a turn runs: they queue, and a queued one can be removed.
    await send(page, "慢慢讲一下");
    await page.waitForSelector("[data-testid='stop']");
    await send(page, "第二个问题");
    await send(page, "第三个问题");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid='queue'] .queue-item").length === 2);
    const removeButtons = await page.$$("[data-testid='queue-remove']");
    await removeButtons[1].click();
    await page.waitForFunction(() => document.querySelectorAll("[data-testid='queue'] .queue-item").length === 1);
    await waitText(page, "收到：第二个问题", 15_000);
    assert.equal((await text(page)).includes("收到：第三个问题"), false);
    const order = await page.$$eval("[data-role='user'] .bubble-text", (items) => items.map((item) => item.textContent));
    assert.deepEqual(order, ["你好", "慢慢讲一下", "第二个问题"]);

    // Model switch resets the effort to that model's default.
    await page.click("[data-testid='model-control']");
    await page.click("[data-testid='model-grok-4.6']");
    await page.waitForFunction(() => document.querySelector("[data-testid='model-control']").textContent === "grok-4.6");
    await page.waitForFunction(() => document.querySelector("[data-testid='effort-control']").textContent === "高");

    // Approvals, questions and plans wait for a click.
    await send(page, "请读取说明");
    await page.waitForSelector("[data-testid='permission']");
    await page.click("[data-testid='permission-reject-once']");
    await waitText(page, "已拒绝");
    await page.waitForFunction(() => !document.querySelector("[data-testid='permission']"));

    await send(page, "问我一个问题");
    await page.waitForSelector("[data-testid='question']");
    const choices = await page.$$("[data-testid='choice']");
    await choices[1].click();
    await page.click("[data-testid='question-submit']");
    await waitText(page, "你选了：蓝");

    await page.click("[data-testid='mode-control']");
    await page.click("[data-testid='mode-plan']");
    await page.waitForFunction(() => document.querySelector("[data-testid='mode-control']").textContent.includes("计划模式"));
    await send(page, "做个计划");
    await page.waitForSelector("[data-testid='plan-card']");
    assert.match(await page.$eval("[data-testid='plan-card']", (element) => element.textContent), /写入 note\.md/);
    await page.click("[data-testid='plan-approve']");
    await waitText(page, "开始执行计划");
    await page.waitForFunction(() => !document.querySelector("[data-testid='mode-control']").textContent.includes("计划模式"));

    // Slash commands: the menu, a web command and an aside.
    await page.click("[data-testid='composer']");
    await page.type("[data-testid='composer']", "/ren");
    await page.waitForSelector("[data-testid='command-menu']");
    assert.match(await page.$eval("[data-testid='command-menu']", (element) => element.textContent), /\/rename/);
    await page.keyboard.press("Escape");
    await page.click("[data-testid='composer']", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type("[data-testid='composer']", "/btw 在干嘛");
    await page.keyboard.press("Enter");
    await waitText(page, "旁问回答：在干嘛");
    await send(page, "/context");
    await waitText(page, "Context: 1% used");

    // Rewind puts that prompt back into the composer.
    await page.click("[data-testid='session-menu']");
    await page.click("[data-testid='menu-rewind']");
    await page.waitForSelector("[data-testid='turn']");
    const turns = await page.$$("[data-testid='turn']");
    await turns.at(-1).click();
    await page.click("[data-testid='turn-confirm']");
    await page.waitForFunction(() => document.querySelector("[data-testid='composer']").value === "你好");
    await page.waitForFunction(() => document.querySelectorAll("[data-role='user']").length === 0);

    // Rename and delete from the sidebar.
    await page.click("[data-testid='title']");
    await page.click("[data-testid='title-input']", { clickCount: 3 });
    await page.type("[data-testid='title-input']", "网页里改的名");
    await page.keyboard.press("Enter");
    await page.waitForFunction((id) => document.querySelector(`[data-session-id='${id}']`)?.textContent.includes("网页里改的名"), {}, sessionId);
    await page.hover(`[data-session-id='${sessionId}']`);
    await page.click(`[data-session-id='${sessionId}'] ~ .session-actions [data-testid='delete-session']`);
    await page.click("[data-testid='confirm-yes']");
    await page.waitForFunction((id) => !document.querySelector(`[data-session-id='${id}']`), {}, sessionId);
    assert.equal(fs.existsSync(path.join(store.sessionsDir, encodeURIComponent(cwd), sessionId)), false);

    // Narrow screens: the session list slides in (wait for the slide-out after the resize first).
    await page.setViewport({ width: 390, height: 800 });
    await pause(400);
    await page.waitForSelector(".chat-head .only-mobile", { visible: true });
    await page.click(".chat-head .only-mobile");
    await page.waitForSelector(".app.show-list");
    await pause(400);
    assert.equal(await page.$eval(".sidebar", (element) => element.getBoundingClientRect().left >= 0), true);
    const overflow = await page.evaluate(() => [...document.querySelectorAll(".composer-bar > *")].filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1).length);
    assert.equal(overflow, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    hub.stop();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
