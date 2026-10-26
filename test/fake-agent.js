// A stand-in for `grok agent stdio` that speaks the same ACP messages the hub relies on:
// Grok's prompt queue, permission / question / plan requests, config options, rewind and fork.
// It persists summary.json and updates.jsonl under GROK_SESSIONS_DIR like Grok does.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const root = process.env.GROK_SESSIONS_DIR || "";
const sessions = new Map();
const waiting = new Map();
let counter = 0;
let requestId = 9000;

const EFFORTS = [
  { id: "xhigh", value: "xhigh", label: "Extra High Effort" },
  { id: "high", value: "high", label: "High Effort", default: true },
  { id: "medium", value: "medium", label: "Medium Effort" },
  { id: "low", value: "low", label: "Low Effort" },
];
const MODELS = [
  { modelId: "grok-4.7", name: "my", _meta: { reasoningEffort: "xhigh", reasoningEfforts: EFFORTS } },
  { modelId: "grok-4.6", name: "Grok 4.6", _meta: { reasoningEffort: "high", reasoningEfforts: EFFORTS.slice(1) } },
];
const COMMANDS = [
  { name: "compact", description: "Compress conversation history", input: null },
  { name: "context", description: "Show context window usage", input: null },
  { name: "goal", description: "Set an autonomous goal", input: { hint: "<objective>" } },
  { name: "code-review", description: "Strict maintainability review", input: null, _meta: { scope: "bundled" } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const ask = (method, params) => new Promise((resolve) => {
  const id = ++requestId;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionDir(id) {
  const session = sessions.get(id);
  return path.join(root, encodeURIComponent(session.cwd), id);
}

function persist(id, update) {
  if (!root) return;
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const line = { timestamp: Math.floor(Date.now() / 1000), method: "session/update", params: { sessionId: id, update, _meta: { agentTimestampMs: Date.now() } } };
  fs.appendFileSync(path.join(dir, "updates.jsonl"), `${JSON.stringify(line)}\n`);
}

function writeSummary(id) {
  if (!root) return;
  const session = sessions.get(id);
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "summary.json");
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    previous = {};
  }
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({
    ...previous,
    info: { id, cwd: session.cwd },
    generated_title: session.title || previous.generated_title || "",
    created_at: previous.created_at || now,
    updated_at: now,
    last_active_at: now,
    current_model_id: session.model,
    reasoning_effort: session.effort,
    num_chat_messages: session.prompts.length * 2,
  }));
}

function configOptions(session) {
  const model = MODELS.find((item) => item.modelId === session.model) || MODELS[0];
  return [
    { id: "model", category: "model", type: "select", currentValue: session.model, options: MODELS.map((item) => ({ value: item.modelId, name: item.name })) },
    { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: session.effort, options: model._meta.reasoningEfforts.map((item) => ({ value: item.value, name: item.label })) },
  ];
}

function makeSession(id, cwd, meta = {}) {
  const session = {
    id, cwd, model: "grok-4.7", effort: "xhigh", mode: "default", yolo: Boolean(meta.yoloMode),
    queue: [], running: null, prompts: [], title: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedReadTokens: 0, modelCalls: 0, costUsdTicks: 0, numTurns: 0 },
  };
  sessions.set(id, session);
  return session;
}

// Like Grok: tool calls, thoughts and plans are saved as they happen, reply text once per turn.
const SAVED_LIVE = new Set(["agent_thought_chunk", "tool_call", "tool_call_update", "plan", "current_mode_update"]);

function update(id, value) {
  notify("session/update", { sessionId: id, update: value, _meta: { agentTimestampMs: Date.now() } });
  if (SAVED_LIVE.has(value.sessionUpdate)) persist(id, value);
}

function queueChanged(id) {
  const session = sessions.get(id);
  notify("_x.ai/queue/changed", {
    sessionId: id,
    entries: session.queue.map((entry, position) => ({ id: entry.id, version: 0, kind: "prompt", text: entry.text, position })),
    ...(session.running ? { runningPromptId: session.running.id, runningText: session.running.text, runningKind: "prompt" } : {}),
  });
}

function enqueue(id, rpcId, blocks) {
  const session = sessions.get(id);
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const extras = blocks.filter((block) => block.type !== "text").map((block) => block.type);
  session.queue.push({ id: `prompt-${++counter}`, rpcId, text, extras, reply: "" });
  queueChanged(id);
  if (!session.running) setImmediate(() => runNext(id));
}

function runNext(id) {
  const session = sessions.get(id);
  if (!session || session.running || !session.queue.length) return;
  const turn = session.queue.shift();
  session.running = turn;
  turn.index = session.prompts.length;
  session.prompts.push({ index: turn.index, text: turn.text, createdAt: new Date().toISOString() });
  queueChanged(id);
  persist(id, { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.text }, _meta: { promptIndex: turn.index } });
  if (!session.title) {
    session.title = turn.text.slice(0, 30);
    update(id, { sessionUpdate: "session_info_update", title: session.title });
  }
  writeSummary(id);
  script(id, turn).catch((error) => process.stderr.write(`${error.stack}\n`));
}

function say(id, turn, text) {
  turn.reply += text;
  update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

function tool(id, toolCallId, name, kind, input) {
  update(id, { sessionUpdate: "tool_call", toolCallId, title: name, rawInput: input, _meta: { "x.ai/tool": { name, kind } } });
}

function finish(id, turn, stopReason = "end_turn") {
  const session = sessions.get(id);
  if (!session || session.running !== turn) return;
  if (turn.reply) persist(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.reply } });
  const usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedReadTokens: 600, reasoningTokens: 20, modelCalls: 1, apiDurationMs: 400, costUsdTicks: 123_456_789 };
  for (const key of Object.keys(session.usage)) session.usage[key] += usage[key] || 0;
  session.usage.numTurns += 1;
  const done = { sessionUpdate: "turn_completed", prompt_id: turn.id, stop_reason: stopReason, usage, elapsed_ms: 1500 };
  session.running = null;
  queueChanged(id);
  notify("_x.ai/session_notification", { sessionId: id, update: done, _meta: { agentTimestampMs: Date.now() } });
  persist(id, done);
  writeSummary(id);
  reply(turn.rpcId, { stopReason, _meta: { promptId: turn.id } });
  setImmediate(() => runNext(id));
}

async function script(id, turn) {
  const session = sessions.get(id);
  const text = turn.text;
  if (text.startsWith("/context")) {
    say(id, turn, "**Context:** 1% used");
    finish(id, turn);
    return;
  }
  if (text.includes("停一下")) return;
  if (text.includes("慢")) {
    for (let index = 0; index < 6 && session.running === turn; index += 1) {
      say(id, turn, `第${index + 1}段。`);
      await wait(150);
    }
    finish(id, turn);
    return;
  }
  if (text.includes("读取")) {
    tool(id, "call-read", "read_file", "read", { target_file: "README.md" });
    const result = await ask("session/request_permission", {
      sessionId: id,
      toolCall: { toolCallId: "call-read", title: "Read `README.md`", rawInput: { target_file: "README.md" }, _meta: { "x.ai/tool": { name: "read_file", kind: "read" } } },
      options: [
        { optionId: "allow-once", name: "Yes", kind: "allow_once" },
        { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
      ],
    });
    if (session.running !== turn) return;
    if (result?.outcome?.optionId === "allow-once") {
      update(id, { sessionUpdate: "tool_call_update", toolCallId: "call-read", status: "completed", content: [{ type: "content", content: { type: "text", text: "# README" } }] });
      say(id, turn, "已读取");
      finish(id, turn);
    } else {
      update(id, { sessionUpdate: "tool_call_update", toolCallId: "call-read", status: "failed", content: [{ type: "content", content: { type: "text", text: "User rejected the execution" } }] });
      say(id, turn, "已拒绝");
      finish(id, turn, "cancelled");
    }
    return;
  }
  if (text.includes("问我")) {
    tool(id, "call-ask", "ask_user_question", "ask_user", { questions: [{ question: "喜欢什么颜色？" }] });
    const result = await ask("_x.ai/ask_user_question", {
      sessionId: id,
      toolCallId: "call-ask",
      questions: [{ question: "喜欢什么颜色？", options: [{ label: "红", description: "红色" }, { label: "蓝", description: "蓝色" }], multiSelect: null }],
      mode: "default",
    });
    if (session.running !== turn) return;
    if (result?.outcome === "accepted") say(id, turn, `你选了：${[].concat(result.answers?.["喜欢什么颜色？"] ?? "").join("、")}`);
    else say(id, turn, `没有回答（${result?.outcome}）`);
    update(id, { sessionUpdate: "tool_call_update", toolCallId: "call-ask", status: "completed" });
    finish(id, turn);
    return;
  }
  if (session.mode === "plan") {
    update(id, { sessionUpdate: "plan", entries: [{ content: "写入 note.md", priority: "medium", status: "pending" }] });
    tool(id, "call-plan", "exit_plan_mode", "exit_plan", {});
    const result = await ask("_x.ai/exit_plan_mode", { sessionId: id, toolCallId: "call-plan", planContent: "# 计划\n\n1. 写入 note.md" });
    if (session.running !== turn) return;
    if (result?.outcome === "approved" || result?.outcome === "abandoned") {
      session.mode = "default";
      update(id, { sessionUpdate: "current_mode_update", currentModeId: "default" });
    }
    say(id, turn, result?.outcome === "approved" ? "开始执行计划" : result?.outcome === "abandoned" ? "计划已放弃" : `按意见修改：${result?.feedback || "（没写意见）"}`);
    finish(id, turn);
    return;
  }
  update(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想了一下。" } });
  tool(id, `call-${turn.id}`, "read_file", "read", { target_file: path.join(session.cwd, "a.txt") });
  update(id, { sessionUpdate: "tool_call_update", toolCallId: `call-${turn.id}`, status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] });
  say(id, turn, `收到：${text}${turn.extras.length ? `（含附件 ${turn.extras.join(",")}）` : ""}`);
  finish(id, turn);
}

function replay(id) {
  if (!root) return;
  const file = path.join(sessionDir(id), "updates.jsonl");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const value = row.params?.update || row.update;
    if (!value) continue;
    if (value.sessionUpdate === "user_message_chunk") {
      const session = sessions.get(id);
      const index = value._meta?.promptIndex ?? session.prompts.length;
      session.prompts.push({ index, text: value.content?.text || "", createdAt: new Date().toISOString() });
    }
    notify("session/update", { sessionId: id, update: value });
  }
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    _meta: { modelState: { currentModelId: "grok-4.7", availableModels: MODELS }, availableCommands: COMMANDS.slice(0, 2) },
  }),
  "session/new": (params) => {
    const id = `01a17000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
    const session = makeSession(id, params.cwd, params._meta);
    writeSummary(id);
    setImmediate(() => update(id, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS }));
    return { sessionId: id, configOptions: configOptions(session) };
  },
  "session/load": (params) => {
    let session = sessions.get(params.sessionId);
    if (!session) {
      session = makeSession(params.sessionId, params.cwd, params._meta);
      replay(params.sessionId);
    }
    session.yolo = Boolean(params._meta?.yoloMode);
    setImmediate(() => update(params.sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS }));
    return { configOptions: configOptions(session) };
  },
  "session/set_config_option": (params) => {
    const session = sessions.get(params.sessionId);
    if (typeof params.value !== "string") throw Object.assign(new Error("Invalid params"), { code: -32602 });
    if (params.configId === "model") {
      session.model = params.value;
      session.effort = (MODELS.find((item) => item.modelId === params.value) || MODELS[0])._meta.reasoningEffort;
    } else {
      session.effort = params.value;
    }
    setImmediate(() => notify("_x.ai/session_notification", { sessionId: params.sessionId, update: { sessionUpdate: "model_changed", model_id: session.model, reasoning_effort: session.effort } }));
    return { configOptions: configOptions(session) };
  },
  "session/set_mode": (params) => {
    const session = sessions.get(params.sessionId);
    session.mode = params.modeId === "plan" ? "plan" : "default";
    setImmediate(() => update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: session.mode }));
    return {};
  },
  "_x.ai/session/close": (params) => {
    sessions.delete(params.sessionId);
    return { result: { success: true, outcome: "closed" } };
  },
  "_x.ai/session/rename": (params) => {
    const file = path.join(root, encodeURIComponent(params.cwd), params.sessionId, "summary.json");
    const summary = JSON.parse(fs.readFileSync(file, "utf8"));
    summary.title_is_manual = !params.resetToAuto;
    if (!params.resetToAuto) summary.generated_title = params.title;
    fs.writeFileSync(file, JSON.stringify(summary));
    const session = sessions.get(params.sessionId);
    if (session && !params.resetToAuto) session.title = params.title;
    return { success: true };
  },
  "_x.ai/session/usage": (params) => ({ usage: sessions.get(params.sessionId)?.usage || {} }),
  "_x.ai/rewind/points": (params) => ({
    rewind_points: (sessions.get(params.sessionId)?.prompts || []).map((prompt) => ({
      prompt_index: prompt.index, created_at: prompt.createdAt, num_file_snapshots: 0, has_file_changes: false, prompt_preview: prompt.text,
    })),
  }),
  "_x.ai/rewind/execute": (params) => {
    const session = sessions.get(params.sessionId);
    const target = session.prompts.find((prompt) => prompt.index === params.targetPromptIndex);
    if (!params.force || !target) return { success: false, error: null };
    session.prompts = session.prompts.filter((prompt) => prompt.index < params.targetPromptIndex);
    persist(params.sessionId, { sessionUpdate: "rewind_marker", target_prompt_index: params.targetPromptIndex });
    return { success: true, target_prompt_index: params.targetPromptIndex, mode: params.mode, prompt_text: target.text, reverted_files: [], conflicts: [] };
  },
  "_x.ai/session/fork": (params) => {
    const id = `01a17000-0000-7000-9000-${String(++counter).padStart(12, "0")}`;
    const source = path.join(root, encodeURIComponent(params.sourceCwd), params.sourceSessionId);
    const target = path.join(root, encodeURIComponent(params.newCwd), id);
    fs.mkdirSync(target, { recursive: true });
    for (const name of ["summary.json", "updates.jsonl"]) {
      if (fs.existsSync(path.join(source, name))) fs.copyFileSync(path.join(source, name), path.join(target, name));
    }
    const summaryFile = path.join(target, "summary.json");
    if (fs.existsSync(summaryFile)) {
      const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
      fs.writeFileSync(summaryFile, JSON.stringify({ ...summary, info: { id, cwd: params.newCwd }, parent_session_id: params.sourceSessionId }));
    }
    return { newSessionId: id, chatMessagesCopied: 0, updatesCopied: 0, newCwd: params.newCwd, parentSessionId: params.sourceSessionId };
  },
  "_x.ai/btw": (params) => ({ result: { answer: `旁问回答：${params.question}` } }),
  "_x.ai/skills/list": () => ({ result: { skills: [{ name: "code-review", short_description: "严格审查", scope: "bundled", enabled: true, user_invocable: true }] } }),
  "_x.ai/mcp/list": () => ({ result: { servers: [] } }),
  "_x.ai/plugins/list": () => ({ result: { plugins: [] } }),
  "_x.ai/hooks/list": () => ({ result: { hooks: [] } }),
  "_x.ai/memory/list": () => ({ files: [], enabled: false, disabled_reason: "not_configured" }),
};

const notifications = {
  "session/cancel": (params) => {
    const session = sessions.get(params.sessionId);
    if (session?.running) finish(params.sessionId, session.running, "cancelled");
  },
  "_x.ai/queue/remove": (params) => {
    const session = sessions.get(params.sessionId);
    const at = session?.queue.findIndex((entry) => entry.id === params.id) ?? -1;
    if (at < 0) return;
    const [entry] = session.queue.splice(at, 1);
    queueChanged(params.sessionId);
    reply(entry.rpcId, { stopReason: "cancelled" });
  },
  "_x.ai/queue/interject": (params) => {
    const session = sessions.get(params.sessionId);
    const at = session?.queue.findIndex((entry) => entry.id === params.id) ?? -1;
    if (at < 0) return;
    const [entry] = session.queue.splice(at, 1);
    session.queue.unshift(entry);
    queueChanged(params.sessionId);
    if (session.running) finish(params.sessionId, session.running, "cancelled");
  },
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!message.method) {
    const resolve = waiting.get(message.id);
    if (resolve) {
      waiting.delete(message.id);
      resolve(message.result);
    }
    return;
  }
  if (message.id === undefined) {
    notifications[message.method]?.(message.params || {});
    return;
  }
  if (message.method === "session/prompt") {
    if (!sessions.has(message.params.sessionId)) {
      fail(message.id, -32002, "session not found");
      return;
    }
    enqueue(message.params.sessionId, message.id, message.params.prompt || []);
    return;
  }
  const handler = handlers[message.method];
  if (!handler) {
    fail(message.id, -32601, "Method not found");
    return;
  }
  try {
    reply(message.id, handler(message.params || {}));
  } catch (error) {
    fail(message.id, error.code || -32603, error.message);
  }
});
