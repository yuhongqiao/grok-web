import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { startCodexAgent } from "../server/codex-agent.js";
import { createCodexWorkspace } from "../server/codex-workspace.js";
import { createCodexHub } from "../server/codex.js";
import { createBrowserLab } from "../server/codex-browser.js";
import { createApp } from "../server/index.js";
import { tempRoot, listen, storeFor } from "./helpers.js";
import { waitFor } from "./codex-helpers.js";

test("native CLI accepts permission selection and granular approvals without changing global configuration", { skip: !process.env.CODEX_NATIVE_TEST, timeout: 45_000 }, async () => {
  const root = tempRoot();
  const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  const digest = () => fs.existsSync(configPath) ? createHash("sha256").update(fs.readFileSync(configPath)).digest("hex") : "missing";
  const before = digest();
  const requests = [];
  let agent;
  const hub = createCodexHub({ projectsFile: path.join(root, "projects.json"), spawnAgent: () => {
    agent = startCodexAgent({ command: process.env.CODEX_AGENT_COMMAND || "codex" });
    const request = agent.request;
    agent.request = (method, params, timeout) => {
      requests.push({ method, params: structuredClone(params) });
      return request(method, method === "thread/start" ? { ...params, ephemeral: true } : params, timeout);
    };
    return agent;
  } });
  try {
    const catalog = await hub.permissions(root);
    for (const id of [":read-only", ":workspace", ":danger-full-access"]) assert.equal(catalog.profiles.some((entry) => entry.id === id && entry.allowed), true);
    const initial = await hub.create({ cwd: root, mode: "default", approvalPolicy: "default" });
    const start = requests.find((entry) => entry.method === "thread/start").params;
    assert.equal(Object.hasOwn(start, "sandbox"), false);
    assert.equal(Object.hasOwn(start, "permissions"), false);
    assert.equal(Object.hasOwn(start, "approvalPolicy"), false);
    const originalSandbox = structuredClone(initial.settings.sandbox);
    const id = initial.thread.id;
    await hub.settings(id, { approvalPolicy: "untrusted" });
    assert.deepEqual(hub.snapshot(id).settings.sandbox, originalSandbox);
    for (const [profile, type] of [[":workspace", "workspaceWrite"], [":danger-full-access", "dangerFullAccess"], [":read-only", "readOnly"]]) {
      await hub.settings(id, { permissions: profile });
      await waitFor(() => hub.snapshot(id).settings.activePermissionProfile?.id === profile);
      assert.equal(hub.snapshot(id).settings.sandbox.type, type);
      assert.equal(hub.snapshot(id).settings.approvalPolicy, "untrusted");
    }
    const granular = { granular: { sandbox_approval: true, rules: false, mcp_elicitations: true, request_permissions: true, skill_approval: false } };
    for (const approvalPolicy of ["on-request", "never", granular]) {
      await hub.settings(id, { approvalPolicy });
      assert.deepEqual(hub.snapshot(id).settings.approvalPolicy, approvalPolicy);
      assert.equal(hub.snapshot(id).settings.sandbox.type, "readOnly");
    }
    const full = await hub.create({ cwd: root, permissions: ":danger-full-access", approvalPolicy: "on-request" });
    assert.equal(full.settings.sandbox.type, "dangerFullAccess");
    assert.equal(full.settings.activePermissionProfile.id, ":danger-full-access");
    assert.equal(full.settings.approvalPolicy, "on-request");
    assert.equal(full.thread.turns.length, 0);
    assert.equal(digest(), before);
  } finally { hub.stop(); if (agent) await agent.exited; assert.equal(digest(), before); }
});

test("native CLI preserves configuration and permissions while adding browser MCP, files, Git and PTY", { skip: !process.env.CODEX_NATIVE_TEST, timeout: 90_000 }, async () => {
  const root = tempRoot();
  const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  const configDigest = () => fs.existsSync(configPath) ? createHash("sha256").update(fs.readFileSync(configPath)).digest("hex") : "missing";
  const before = configDigest();
  const command = process.env.CODEX_AGENT_COMMAND || "codex";
  const plain = startCodexAgent({ command });
  const lab = createBrowserLab({ dataDir: path.join(root, "browser"), headless: true });
  const token = randomBytes(32).toString("hex");
  const { server, port } = await listen(createApp({ store: storeFor(root), hub: {}, browser: lab, browserToken: token }));
  const name = `grok_web_native_test_${process.pid}`;
  let agent; let workspace;
  try {
    await plain.ready;
    const original = await plain.request("config/read", { cwd: root, includeLayers: false });
    agent = startCodexAgent({ command, browserBridge: { name, script: fileURLToPath(new URL("../server/browser-mcp.js", import.meta.url)), url: `http://127.0.0.1:${port}/api/codex/browser/mcp`, token } });
    await agent.ready;
    const added = await agent.request("config/read", { cwd: root, includeLayers: false });
    assert.equal(added.config.sandbox_mode, original.config.sandbox_mode);
    assert.equal(added.config.approval_policy, original.config.approval_policy);
    assert.deepEqual(added.config.features, original.config.features);
    const servers = { ...added.config.mcp_servers }; delete servers[name];
    assert.deepEqual(servers, original.config.mcp_servers || {});
    const { thread } = await agent.request("thread/start", { cwd: root, ephemeral: true });
    const status = await agent.request("mcpServerStatus/list", { threadId: thread.id, serverName: name, detail: "full" });
    assert.ok(JSON.stringify(status).includes("browser_open"));
    const result = await agent.request("mcpServer/tool/call", { threadId: thread.id, server: name, tool: "browser_snapshot", arguments: { projectPath: root } });
    assert.ok(JSON.stringify(result).includes('opened'));
    workspace = createCodexWorkspace({ native: (...args) => agent.request(...args), watchAgent: (send) => { agent.subscribe(send); return () => {}; } });
    fs.writeFileSync(path.join(root, "hello.txt"), "before\n");
    assert.equal((await workspace.tree(root, "")).entries.some((entry) => entry.fileName === "hello.txt"), true);
    const file = await workspace.read(root, "hello.txt");
    await workspace.write(root, "hello.txt", "after\n", file.revision);
    await assert.rejects(workspace.write(root, "hello.txt", "stale", file.revision), /修改/);
    await assert.rejects(workspace.read(root, "../escape"), /项目内/);
    fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
    await assert.rejects(workspace.tree(root, "outside"), /项目以外/);
    const setupGit = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    setupGit("init"); setupGit("config", "user.email", "native-test@example.invalid"); setupGit("config", "user.name", "Native Test");
    let nativeGitWrite = true;
    try { await workspace.git(root, "stage", { paths: ["hello.txt"] }); }
    catch (error) { assert.match(error.message, /permitted|denied|read.only/i); nativeGitWrite = false; }
    if (nativeGitWrite) {
      await workspace.git(root, "unstage", { paths: ["hello.txt"] });
      await workspace.git(root, "stage", { paths: ["hello.txt"] });
      await workspace.git(root, "commit", { message: "Isolated native integration test" });
      await workspace.git(root, "branch", { name: "native-verification" });
    } else {
      setupGit("add", "hello.txt"); setupGit("commit", "-m", "Isolated native integration test");
      console.log("Native Git sandbox refusal preserved; UI can hand the request to the native Codex approval flow.");
    }
    assert.ok((await workspace.git(root, "status")).branch);
    fs.writeFileSync(path.join(root, "hello.txt"), "native diff\n");
    assert.match((await workspace.git(root, "diff", { path: "hello.txt" })).diff, /native diff/);
    const terminal = await workspace.start(root, { kind: "terminal" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await workspace.process(root, terminal.id, "write", { text: "printf 'PTY_VERIFIED\\n'\n" });
    await waitFor(() => workspace.list(root).processes.find((entry) => entry.id === terminal.id)?.output.includes("PTY_VERIFIED\r\n"), 10_000);
    await workspace.process(root, terminal.id, "resize", { cols: 90, rows: 30 });
    await workspace.process(root, terminal.id, "stop");
    await waitFor(() => !workspace.list(root).processes.find((entry) => entry.id === terminal.id)?.running);
    const service = await workspace.start(root, { kind: "service", command: "printf SERVICE_VERIFIED" });
    await waitFor(() => !workspace.list(root).processes.find((entry) => entry.id === service.id)?.running);
    assert.match(workspace.list(root).processes.find((entry) => entry.id === service.id).output, /SERVICE_VERIFIED/);
    assert.equal(configDigest(), before);
    console.log(`Native CLI compatibility verified; global config unchanged; project: ${root}`);
  } finally {
    workspace?.close(); agent?.stop(); plain.stop(); await lab.stop();
    await Promise.allSettled([agent?.exited, plain.exited]); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
    assert.equal(configDigest(), before);
  }
});
