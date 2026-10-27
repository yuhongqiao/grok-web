// Isolated synthetic app-server for tests; never calls a model or executes shell commands.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const home = process.env.CODEX_FAKE_HOME;
fs.mkdirSync(home, { recursive: true });
const timers = new Map();
const requests = new Map();
const nativeProcesses = new Map();
let requestId = 100;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const save = (thread) => fs.writeFileSync(path.join(home, `${thread.id}.json`), JSON.stringify(thread));
const read = (id) => JSON.parse(fs.readFileSync(path.join(home, `${id}.json`), "utf8"));
const settings = (thread) => ({ thread, model: thread.model, reasoningEffort: thread.reasoningEffort, collaborationMode: thread.collaborationMode, cwd: thread.cwd, approvalPolicy: thread.approvalPolicy || "on-request", sandbox: thread.sandbox || { type: "workspaceWrite" }, activePermissionProfile: thread.activePermissionProfile === undefined ? { id: ":workspace" } : thread.activePermissionProfile });
const active = (thread) => thread.turns.at(-1);
const profiles = [":read-only", ":workspace", ":danger-full-access", "project-test", "blocked-test"].map((id) => ({ id, allowed: id !== "blocked-test", description: id === "project-test" ? "Synthetic project permissions" : null }));

function applyPermissions(thread, p) {
  if (p.permissions && (p.sandbox || p.sandboxPolicy)) throw new Error("conflicting sandbox and permissions");
  if (p.permissions) {
    if (!profiles.some((entry) => entry.id === p.permissions && entry.allowed)) throw new Error("profile not allowed");
    thread.activePermissionProfile = { id: p.permissions };
    thread.sandbox = p.permissions === "project-test" ? { type: "workspaceWrite", networkAccess: true, writableRoots: [thread.cwd] } : { type: { ":read-only": "readOnly", ":workspace": "workspaceWrite", ":danger-full-access": "dangerFullAccess" }[p.permissions] };
  }
  if (p.sandbox || p.sandboxPolicy) {
    thread.sandbox = p.sandboxPolicy || { type: { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[p.sandbox] };
    thread.activePermissionProfile = null;
  }
  if (p.approvalPolicy !== undefined) thread.approvalPolicy = p.approvalPolicy;
}

function notifySettings(thread) {
  const current = settings(thread);
  notify("thread/settings/updated", { threadId: thread.id, threadSettings: { ...current, sandboxPolicy: current.sandbox, effort: current.reasoningEffort } });
}

function finish(id, text, status = "completed") {
  const thread = read(id);
  const turn = active(thread);
  const item = { id: `${turn.id}-answer`, type: "agentMessage", text };
  for (const tool of turn.items.filter((entry) => entry.status === "inProgress")) {
    tool.status = status === "interrupted" ? "declined" : "completed";
    notify("item/completed", { threadId: id, turnId: turn.id, item: tool });
  }
  turn.items.push(item);
  turn.status = status;
  turn.durationMs = 100;
  thread.status = { type: "idle" };
  save(thread);
  notify("item/completed", { threadId: id, turnId: turn.id, item });
  notify("turn/completed", { threadId: id, turn: { ...turn, items: [] } });
}

function stream(id, text, slow) {
  const thread = read(id);
  const turn = active(thread);
  const itemId = `${turn.id}-answer`;
  notify("item/started", { threadId: id, turnId: turn.id, item: { id: itemId, type: "agentMessage", text: "" } });
  notify("item/agentMessage/delta", { threadId: id, turnId: turn.id, itemId, delta: "收到：" });
  timers.set(id, setTimeout(() => {
    notify("item/agentMessage/delta", { threadId: id, turnId: turn.id, itemId, delta: text });
    finish(id, `收到：${text}`);
    timers.delete(id);
  }, slow ? 3500 : 80));
}

function ask(id, method, extra = {}) {
  const thread = read(id);
  const turn = active(thread);
  const item = method.includes("fileChange")
    ? { id: `${turn.id}-tool`, type: "fileChange", status: "inProgress", changes: [{ path: "example.txt", kind: { type: "add" }, diff: "+synthetic test content" }] }
    : { id: `${turn.id}-tool`, type: "commandExecution", command: "printf test", cwd: thread.cwd, commandActions: [], status: "inProgress" };
  turn.items.push(item);
  save(thread);
  notify("item/started", { threadId: id, turnId: turn.id, item });
  const rpcId = ++requestId;
  requests.set(rpcId, { id, method });
  send({ id: rpcId, method, params: { threadId: id, turnId: turn.id, itemId: item.id, startedAtMs: Date.now(), ...extra } });
}

async function handle(message) {
  if (!message.method) {
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    notify("serverRequest/resolved", { threadId: request.id, requestId: message.id });
    if (request.method === "item/tool/requestUserInput") finish(request.id, message.result.answers.choice ? `回答：${message.result.answers.choice.answers[0]}` : "已跳过");
    else if (request.method === "mcpServer/elicitation/request") finish(request.id, message.result.action === "accept" ? `表单：${JSON.stringify(message.result.content)}` : "已取消表单");
    else finish(request.id, ["accept", "acceptForSession"].includes(message.result.decision) || message.result.permissions?.network ? "已允许" : "已拒绝", message.result.decision === "cancel" ? "interrupted" : "completed");
    return;
  }
  const p = message.params || {};
  let result;
  switch (message.method) {
    case "initialized": return;
    case "initialize": result = { userAgent: "fake-codex/1", platformOs: "test" }; break;
    case "fs/readFile": result = { dataBase64: fs.readFileSync(p.path).toString("base64") }; break;
    case "fs/writeFile": fs.writeFileSync(p.path, Buffer.from(p.dataBase64, "base64")); result = {}; break;
    case "fs/readDirectory": result = { entries: fs.readdirSync(p.path, { withFileTypes: true }).map((entry) => ({ fileName: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() })) }; break;
    case "command/exec": {
      if (!p.processId) { result = { exitCode: 0, stdout: p.command.includes("--show-current") ? "main\n" : p.command.includes("--format=%(refname:short)") ? "main\n" : "", stderr: "" }; break; }
      nativeProcesses.set(p.processId, message.id);
      setTimeout(() => notify("command/exec/outputDelta", { processId: p.processId, stream: "stdout", deltaBase64: Buffer.from(p.tty ? "synthetic native terminal ready\r\n$ " : "synthetic service ready\n").toString("base64"), capReached: false }), 50);
      return;
    }
    case "command/exec/write": notify("command/exec/outputDelta", { processId: p.processId, stream: "stdout", deltaBase64: Buffer.from(`synthetic terminal input: ${Buffer.from(p.deltaBase64, "base64").toString()}`).toString("base64"), capReached: false }); result = {}; break;
    case "command/exec/resize": result = {}; break;
    case "command/exec/terminate": send({ id: nativeProcesses.get(p.processId), result: { exitCode: 0, stdout: "", stderr: "" } }); nativeProcesses.delete(p.processId); result = {}; break;
    case "review/start": {
      const thread = read(p.threadId); const turn = { id: randomUUID(), status: "inProgress", items: [] };
      thread.turns.push(turn); save(thread); notify("turn/started", { threadId: thread.id, turn });
      setTimeout(() => finish(thread.id, `原生审查完成：${p.target.type}`), 80);
      result = { reviewThreadId: thread.id, turn }; break;
    }
    case "account/read": result = { account: { type: "apiKey" }, requiresOpenaiAuth: true }; break;
    case "model/list": result = { data: ["codex-test", "codex-other"].map((model, index) => ({ id: model, model, displayName: model, isDefault: index === 0, hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) })), nextCursor: null }; break;
    case "collaborationMode/list": result = { data: [{ name: "Default", mode: "default" }, { name: "Plan", mode: "plan" }] }; break;
    case "permissionProfile/list": {
      if (fs.existsSync(path.join(home, "legacy-permissions"))) throw Object.assign(new Error("method not found"), { code: -32601 });
      const start = Number(p.cursor || 0);
      result = { data: profiles.slice(start, start + 2), nextCursor: start + 2 < profiles.length ? String(start + 2) : null }; break;
    }
    case "skills/list": result = { data: p.cwds.map((cwd) => ({ cwd, errors: [], skills: [{ name: "sample-skill", path: path.join(cwd, "skills/sample-skill/SKILL.md"), description: "隔离测试技能，不执行任何操作", shortDescription: "示例技能", enabled: !fs.existsSync(path.join(home, "skill-disabled")), scope: "repo" }] })) }; break;
    case "skills/config/write": if (p.enabled) fs.rmSync(path.join(home, "skill-disabled"), { force: true }); else fs.writeFileSync(path.join(home, "skill-disabled"), "disabled"); result = {}; break;
    case "fuzzyFileSearch": result = { files: fs.readdirSync(p.roots[0], { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.includes(p.query)).map((entry) => ({ path: entry.name, file_name: entry.name, root: p.roots[0], score: 1, match_type: "file" })) }; break;
    case "thread/list": {
      const data = fs.readdirSync(home).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(home, name)))).filter((thread) => Boolean(thread.archived) === Boolean(p.archived) && (!p.sourceKinds?.length || p.sourceKinds.includes(thread.source))).sort((a, b) => b.updatedAt - a.updatedAt);
      const start = Number(p.cursor || 0);
      result = { data: data.slice(start, start + p.limit).map((thread) => ({ ...thread, turns: [] })), nextCursor: data.length > start + p.limit ? String(start + p.limit) : null };
      break;
    }
    case "thread/search": {
      const needle = p.searchTerm.toLowerCase();
      const data = fs.readdirSync(home).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(home, name)))).filter((thread) => Boolean(thread.archived) === Boolean(p.archived) && JSON.stringify([thread.name, thread.preview, thread.turns]).toLowerCase().includes(needle));
      const start = Number(p.cursor || 0);
      result = { data: data.slice(start, start + p.limit).map((thread) => ({ thread: { ...thread, turns: [] }, snippet: thread.turns.flatMap((turn) => turn.items).find((item) => JSON.stringify(item).toLowerCase().includes(needle))?.text || p.searchTerm })), nextCursor: data.length > start + p.limit ? String(start + p.limit) : null }; break;
    }
    case "thread/start": {
      const thread = { id: randomUUID(), cwd: p.cwd, name: null, preview: "", model: p.model || "codex-test", reasoningEffort: "medium", modelProvider: "synthetic", source: "vscode", createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, turns: [], status: { type: "idle" }, historyMode: p.historyMode || "legacy" };
      applyPermissions(thread, p);
      save(thread);
      result = settings(thread);
      break;
    }
    case "thread/resume": {
      const thread = read(p.threadId);
      // The real CLI marks unfinished turns interrupted after a process restart.
      if (!timers.has(thread.id) && ![...requests.values()].some((request) => request.id === thread.id)) {
        for (const turn of thread.turns) if (turn.status === "inProgress") turn.status = "interrupted";
        thread.status = { type: "idle" };
        save(thread);
      }
      result = settings(thread.historyMode === "paginated" ? { ...thread, turns: [] } : thread);
      break;
    }
    case "thread/turns/list": {
      const turns = read(p.threadId).turns;
      const start = Number(p.cursor || 0);
      result = { data: turns.slice(start, start + 2), nextCursor: turns.length > start + 2 ? String(start + 2) : null };
      break;
    }
    case "turn/start": {
      const text = p.input.find((part) => part.type === "text")?.text || "图片消息";
      if (text === "fail") throw new Error("synthetic provider unavailable");
      const thread = read(p.threadId);
      if (active(thread)?.status === "inProgress") throw new Error("already running");
      const turn = { id: randomUUID(), status: "inProgress", items: [{ id: randomUUID(), type: "userMessage", content: p.input }] };
      thread.turns.push(turn);
      thread.preview ||= text;
      thread.updatedAt = Date.now() / 1000;
      thread.status = { type: "active" };
      thread.model = p.model || thread.model;
      thread.reasoningEffort = p.effort || thread.reasoningEffort;
      applyPermissions(thread, p);
      if (p.collaborationMode) { thread.collaborationMode = p.collaborationMode; thread.model = p.collaborationMode.settings.model; thread.reasoningEffort = p.collaborationMode.settings.reasoning_effort; }
      save(thread);
      notifySettings(thread);
      notify("turn/started", { threadId: thread.id, turn: { ...turn, items: [] } });
      notify("item/completed", { threadId: thread.id, turnId: turn.id, item: turn.items[0] });
      if (text === "crash") { send({ id: message.id, result: { turn: { ...turn, items: [] } } }); setTimeout(() => process.exit(1), 50); return; }
      if (text === "approval") ask(thread.id, "item/commandExecution/requestApproval", { command: "printf test", cwd: thread.cwd, reason: "模拟命令审批" });
      else if (text === "file approval") ask(thread.id, "item/fileChange/requestApproval", { reason: "模拟文件审批" });
      else if (text === "permissions") ask(thread.id, "item/permissions/requestApproval", { cwd: thread.cwd, permissions: { network: { enabled: true } }, reason: "模拟权限审批" });
      else if (text === "question") ask(thread.id, "item/tool/requestUserInput", { isBlocking: true, questions: [{ id: "choice", header: "选择", question: "选一个颜色", options: [{ label: "蓝色", description: "蓝色选项" }, { label: "绿色", description: "绿色选项" }] }] });
      else if (text === "restricted approval") ask(thread.id, "item/commandExecution/requestApproval", { command: "printf test", availableDecisions: ["accept", "decline"] });
      else if (text === "mcp form") ask(thread.id, "mcpServer/elicitation/request", { serverName: "synthetic-mcp", mode: "form", message: "填写隔离测试表单", requestedSchema: { type: "object", required: ["name", "count", "choice"], properties: { name: { type: "string", title: "名称", minLength: 2 }, count: { type: "integer", title: "数量", minimum: 1, maximum: 10 }, choice: { type: "string", title: "选项", enum: ["blue", "green"] }, remember: { type: "boolean", title: "记住", default: false } } } });
      else if (text === "fast") finish(thread.id, "瞬间完成");
      else stream(thread.id, text, text.startsWith("slow"));
      result = { turn: { ...turn, items: [] } };
      break;
    }
    case "turn/interrupt": {
      clearTimeout(timers.get(p.threadId));
      timers.delete(p.threadId);
      for (const [key, request] of requests) if (request.id === p.threadId) { requests.delete(key); notify("serverRequest/resolved", { threadId: p.threadId, requestId: key }); }
      finish(p.threadId, "已停止", "interrupted");
      result = {};
      break;
    }
    case "turn/steer": {
      const thread = read(p.threadId);
      const turn = active(thread);
      if (!turn || turn.status !== "inProgress" || turn.id !== p.expectedTurnId) throw new Error("active turn changed");
      const item = { id: randomUUID(), type: "userMessage", content: p.input };
      turn.items.push(item); save(thread);
      notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
      result = { turnId: turn.id }; break;
    }
    case "thread/fork": {
      const source = read(p.threadId);
      const index = p.beforeTurnId ? source.turns.findIndex((turn) => turn.id === p.beforeTurnId) - 1 : p.lastTurnId ? source.turns.findIndex((turn) => turn.id === p.lastTurnId) : source.turns.length - 1;
      const thread = { ...source, id: randomUUID(), name: null, turns: source.turns.slice(0, index + 1), updatedAt: Date.now() / 1000, archived: false };
      save(thread); result = settings({ ...thread, turns: [] }); break;
    }
    case "thread/revert": {
      const thread = read(p.threadId);
      const index = thread.turns.findIndex((turn) => turn.id === p.beforeTurnId);
      if (thread.historyMode !== "paginated" || index < 0) throw new Error("invalid revert target");
      thread.turns = thread.turns.slice(0, index); save(thread);
      result = { thread: { ...thread, turns: [] } }; break;
    }
    case "thread/settings/update": {
      const thread = read(p.threadId);
      if (p.model) thread.model = p.model;
      if (p.effort) thread.reasoningEffort = p.effort;
      applyPermissions(thread, p);
      if (p.collaborationMode) thread.collaborationMode = p.collaborationMode;
      save(thread); notifySettings(thread); result = {}; break;
    }
    case "thread/compact/start": {
      const thread = read(p.threadId);
      const turn = { id: randomUUID(), status: "inProgress", items: [{ id: randomUUID(), type: "contextCompaction" }] };
      setTimeout(() => {
        thread.turns.push(turn); save(thread);
        notify("turn/started", { threadId: thread.id, turn });
        finish(thread.id, "上下文压缩完成");
      }, 60);
      result = {}; break;
    }
    case "thread/name/set": {
      const thread = read(p.threadId); thread.name = p.name; save(thread);
      notify("thread/name/updated", { threadId: p.threadId, threadName: p.name }); result = {}; break;
    }
    case "thread/archive": {
      const thread = read(p.threadId); thread.archived = true; save(thread); result = {}; break;
    }
    case "thread/unarchive": {
      const thread = read(p.threadId); thread.archived = false; save(thread); result = { thread }; break;
    }
    default: throw new Error(`unsupported method ${message.method}`);
  }
  send({ id: message.id, result });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  handle(message).catch((error) => send({ id: message.id, error: { code: error.code || -32000, message: error.message } }));
});
