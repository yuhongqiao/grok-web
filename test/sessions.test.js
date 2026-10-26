import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { foldChatHistory, readModelDefaults } from "../server/sessions.js";
import { line, storeFor, tempRoot, writeSession } from "./helpers.js";

const sessionId = "01a16e75-d656-7ee2-a8dd-1ebfba4b3270";

test("chat_history.jsonl folds into the same shape and hides the system prompt", () => {
  const messages = foldChatHistory([
    JSON.stringify({ type: "system", content: "You are Grok. secret system prompt" }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_info>os</user_info>\n<user_query>\n看一下方案\n</user_query>" }] }),
    JSON.stringify({ type: "reasoning", content: "想想" }),
    JSON.stringify({ type: "assistant", content: "看过了" }),
    JSON.stringify({ type: "tool_result", content: "file list" }),
  ].join("\n"));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "看一下方案");
  assert.deepEqual(messages[1].blocks.map((block) => block.type), ["thinking", "text", "tool"]);
  assert.equal(JSON.stringify(messages).includes("secret system prompt"), false);
});

test("config defaults include the permission mode and never the keys", () => {
  const defaults = readModelDefaults(`
[models]
default = "grok-4.7"
default_reasoning_effort = "xhigh"

[model."grok-4.7"]
api_key = "sk-secret"
base_url = "https://example.invalid"

[[model."grok-4.7".reasoning_efforts]]
value = "xhigh"
label = "Extra High Effort"

[[model."grok-4.7".reasoning_efforts]]
value = "high"
label = "High Effort"
default = true

[ui]
yolo = false
permission_mode = "always-approve"
`);
  assert.equal(defaults.model, "grok-4.7");
  assert.equal(defaults.effort, "xhigh");
  assert.equal(defaults.permission, "yolo");
  assert.deepEqual(defaults.models[0].efforts.map((item) => item.id), ["xhigh", "high"]);
  assert.equal(JSON.stringify(defaults).includes("sk-secret"), false);
  assert.equal(JSON.stringify(defaults).includes("example.invalid"), false);
  assert.equal(readModelDefaults("[ui]\npermission_mode = \"auto\"").permission, "auto");
  assert.equal(readModelDefaults("").permission, "ask");
});

test("the store lists projects, finds sessions by id and reads them", () => {
  const root = tempRoot();
  const cwd = path.join(root, "projects", "健身教程");
  fs.mkdirSync(cwd, { recursive: true });
  const store = storeFor(root);
  const dir = writeSession(store.sessionsDir, cwd, sessionId, {
    title: "引体向上",
    updates: [
      line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "怎么练" }, _meta: { promptIndex: 0 } }),
      line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "先悬垂" } }),
    ],
  });
  fs.writeFileSync(path.join(dir, "plan_mode.json"), JSON.stringify({ state: "Active" }));
  fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify({ session: { totalTokens: 1500, inputTokens: 1000, cachedReadTokens: 700, outputTokens: 500, turnCount: 3, costUsdTicks: 2e10 } }));
  fs.writeFileSync(path.join(dir, "plan.md"), "# 计划");
  writeSession(store.sessionsDir, path.join(root, "scratch", "try"), "01a16e75-d656-7ee2-a8dd-1ebfba4b3279", { title: "临时" });

  const state = store.listState();
  assert.deepEqual(state.projects.map((project) => project.name), ["健身教程"]);
  assert.equal(state.projects[0].sessions[0].title, "引体向上");
  assert.equal(state.projects[0].sessions[0].effort, "high");

  assert.deepEqual(store.locateSession(sessionId), { cwd });
  assert.equal(store.locateSession("01a16e75-d656-7ee2-a8dd-000000000000"), null);
  assert.equal(store.locateSession("../etc"), null);

  const info = store.sessionInfo(sessionId, cwd);
  assert.equal(info.mode, "plan");
  assert.equal(info.usage.total, 1500);
  assert.equal(info.usage.turns, 3);
  assert.equal(info.usage.cost, 2);
  assert.equal(store.readPlan(sessionId, cwd), "# 计划");

  const body = store.readSession(sessionId, cwd);
  assert.equal(body.messages[0].text, "怎么练");
  assert.equal(body.messages[1].blocks[0].text, "先悬垂");
  assert.throws(() => store.decodeProjectKey(encodeURIComponent("/tmp/a/../b")), /无效的项目/);
  assert.throws(() => store.readSession("../../x", cwd), /无效的会话/);
});

test("the default project list leaves out system temporary folders", () => {
  const store = storeFor(tempRoot(), { tempDirs: undefined });
  const cwd = path.join(os.homedir(), "grok-web-project");
  writeSession(store.sessionsDir, cwd, sessionId);
  for (const folder of ["/tmp", "/tmp/scratch-session", "/private/tmp", "/private/tmp/scratch-session"]) {
    writeSession(store.sessionsDir, folder, sessionId);
  }
  assert.deepEqual(store.listState().projects.map((project) => project.cwd), [cwd]);
});

test("trash moves the session aside, keeps the code, and refuses while another process holds the lock", { skip: process.platform === "win32" }, async () => {
  const root = tempRoot();
  const cwd = path.join(root, "projects", "demo");
  fs.mkdirSync(cwd, { recursive: true });
  const store = storeFor(root);
  const dir = writeSession(store.sessionsDir, cwd, sessionId, { title: "锁定" });
  const lock = path.join(dir, "summary.json.lock");
  fs.writeFileSync(lock, "");
  const holder = spawn(process.execPath, ["-e", "const fs=require('fs'); fs.openSync(process.env.LOCK,'r+'); setInterval(()=>{}, 1000)"], {
    env: { ...process.env, LOCK: lock },
    stdio: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => store.trashSession(sessionId, cwd), /别处写入/);
    assert.equal(fs.existsSync(dir), true);
    const allowed = store.trashSession(sessionId, cwd, { ignorePids: [holder.pid] });
    assert.equal(fs.existsSync(allowed.trashedTo), true);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(cwd), true);
  } finally {
    holder.kill();
  }
});

test("projects are real folders, removal only hides them, and file search skips build output", () => {
  const root = tempRoot();
  const store = storeFor(root);
  const project = store.createProject({ name: "个人信息" });
  assert.equal(fs.existsSync(project.cwd), true);
  assert.equal(fs.existsSync(path.join(store.sessionsDir, project.encoded)), false);
  fs.mkdirSync(path.join(project.cwd, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(project.cwd, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(project.cwd, "src", "lib", "util.js"), "");
  fs.writeFileSync(path.join(project.cwd, "node_modules", "pkg", "util.js"), "");
  fs.writeFileSync(path.join(project.cwd, "README.md"), "");
  assert.deepEqual(store.searchFiles(project.encoded, "util"), ["src/lib/util.js"]);
  assert.equal(store.searchFiles(project.encoded, "").includes("README.md"), true);
  assert.equal(store.listState().projects.some((item) => item.name === "个人信息"), true);
  store.removeProject(project.encoded);
  assert.equal(store.listState().projects.some((item) => item.name === "个人信息"), false);
  assert.equal(fs.existsSync(project.cwd), true);
  assert.throws(() => store.createProject({ name: "../x" }), /名称无效/);
});

test("a terminal that still holds a session is reported", () => {
  const root = tempRoot();
  const activeSessionsFile = path.join(root, "active_sessions.json");
  fs.writeFileSync(activeSessionsFile, JSON.stringify([
    { session_id: sessionId, pid: process.pid, cwd: "/x" },
    { session_id: "01a16e75-d656-7ee2-a8dd-1ebfba4b3271", pid: 999_999, cwd: "/x" },
  ]));
  const store = storeFor(root, { activeSessionsFile });
  assert.equal(store.heldElsewhere(sessionId), process.pid);
  assert.equal(store.heldElsewhere("01a16e75-d656-7ee2-a8dd-1ebfba4b3271"), 0);
});

test("new projects default to the folder most projects sit in, or a fixed GROK_PARENT_DIR", () => {
  const root = tempRoot();
  const store = storeFor(root, { parentDir: "" });
  assert.equal(store.listState().parent, os.homedir());
  for (const [folder, id] of [["work/a", "01a16e75-d656-7ee2-a8dd-1ebfba4b3281"], ["work/b", "01a16e75-d656-7ee2-a8dd-1ebfba4b3282"], ["other/c", "01a16e75-d656-7ee2-a8dd-1ebfba4b3283"]]) {
    writeSession(store.sessionsDir, path.join(root, folder), id, { title: folder });
  }
  assert.equal(store.listState().parent, path.join(root, "work"));
  assert.equal(store.createProject({ name: "新项目" }).cwd, path.join(root, "work", "新项目"));
  assert.equal(storeFor(root, { parentDir: path.join(root, "fixed") }).listState().parent, path.join(root, "fixed"));
});
