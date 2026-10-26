// Folds Grok session updates (the `update` of ACP `session/update`) into chat messages.
// The server uses it for history on disk and the browser for live events, so both render alike.
//
// user:      { role: "user", text, images: [{ mimeType, data }], files: [name], promptIndex }
// assistant: { role: "assistant", blocks: [...], meta: null | { stopReason, elapsedMs, usage, endedAt } }
// blocks:    { type: "text" | "thinking", text } | { type: "plan", entries } |
//            { type: "tool", id, name, kind, title, status, input, output, diffs, paths }

const MAX_TEXT = 60_000;
const MAX_FIELD = 4_000;
const MAX_IMAGE_CHARS = 6_000_000;

export function applyUpdate(messages, update, meta = {}) {
  switch (update?.sessionUpdate) {
    case "user_message_chunk":
      return addUserChunk(messages, update);
    case "agent_message_chunk":
      return addText(messages, "text", textOf(update.content));
    case "agent_thought_chunk":
      return addText(messages, "thinking", textOf(update.content));
    case "tool_call":
    case "tool_call_update":
      return upsertTool(messages, update);
    case "plan":
      return setPlan(messages, update.entries);
    case "turn_completed":
      return finishTurn(messages, update, meta);
    case "rewind_marker":
      return rewindTo(messages, Number(update.target_prompt_index));
    default:
      return messages;
  }
}

export function foldUpdates(text) {
  let messages = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const params = row?.params || row;
    if (!params?.update || typeof params.update !== "object") continue;
    const timestamp = params._meta?.agentTimestampMs || (row.timestamp ? row.timestamp * 1000 : undefined);
    messages = applyUpdate(messages, params.update, { timestamp });
  }
  return messages;
}

export function usageOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const number = (value) => Number(value) || 0;
  return {
    total: number(usage.totalTokens ?? usage.total_tokens),
    input: number(usage.inputTokens ?? usage.input_tokens),
    output: number(usage.outputTokens ?? usage.output_tokens),
    cached: number(usage.cachedReadTokens ?? usage.cache_read_input_tokens),
    reasoning: number(usage.reasoningTokens ?? usage.reasoning_tokens),
    calls: number(usage.modelCalls),
    turns: number(usage.numTurns ?? usage.turnCount),
    apiMs: number(usage.apiDurationMs),
    cost: number(usage.costUsdTicks) / 1e10,
  };
}

export function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content !== undefined) return textOf(content.content);
  }
  return "";
}

export function messageText(message) {
  if (message?.role === "assistant") {
    return message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  return message?.text || "";
}

function addUserChunk(messages, update) {
  const info = update._meta || {};
  if (info.hideFromScrollback) return messages;
  const content = update.content || {};
  const last = messages.at(-1);
  const same = last?.role === "user" && last.promptIndex === info.promptIndex;
  const next = same
    ? { ...last, images: [...last.images], files: [...last.files] }
    : { role: "user", text: "", images: [], files: [], promptIndex: info.promptIndex };
  if (content.type === "image") {
    const data = typeof content.data === "string" && content.data.length <= MAX_IMAGE_CHARS ? content.data : "";
    next.images.push({ mimeType: content.mimeType || "image/png", data });
  } else if (content.type === "resource_link" || content.type === "resource") {
    next.files.push(String(content.name || content.resource?.uri || content.uri || "附件").split("/").pop());
  } else {
    next.text += unwrap(textOf(content));
  }
  return same ? [...messages.slice(0, -1), next] : [...messages, next];
}

function openAssistant(messages) {
  const tail = messages.at(-1);
  return tail?.role === "assistant" && !tail.meta ? tail : null;
}

function editAssistant(messages, edit) {
  const tail = openAssistant(messages);
  const blocks = tail ? tail.blocks.slice() : [];
  edit(blocks);
  const next = { role: "assistant", blocks, meta: null };
  return tail ? [...messages.slice(0, -1), next] : [...messages, next];
}

function addText(messages, type, text) {
  if (!text) return messages;
  return editAssistant(messages, (blocks) => {
    const last = blocks.at(-1);
    if (last?.type === type) blocks[blocks.length - 1] = { type, text: clip(last.text + text, MAX_TEXT * 2) };
    else blocks.push({ type, text });
  });
}

function upsertTool(messages, update) {
  const id = String(update.toolCallId || "");
  if (id) {
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - 8); index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      const at = message.blocks.findIndex((block) => block.type === "tool" && block.id === id);
      if (at < 0) continue;
      const blocks = message.blocks.slice();
      blocks[at] = mergeTool(blocks[at], update);
      const next = messages.slice();
      next[index] = { ...message, blocks };
      return next;
    }
  }
  return editAssistant(messages, (blocks) => {
    blocks.push(mergeTool({
      type: "tool", id, name: "", kind: "", title: "", status: "pending", input: null, output: "", diffs: [], paths: [],
    }, update));
  });
}

function mergeTool(previous, update) {
  const next = { ...previous };
  const tool = update._meta?.["x.ai/tool"];
  if (tool?.name) next.name = String(tool.name);
  if (tool?.kind) next.kind = String(tool.kind);
  if (update.title) next.title = String(update.title);
  if (!next.name && update.sessionUpdate === "tool_call" && update.title) next.name = String(update.title);
  if (!next.kind && update.kind) next.kind = String(update.kind);
  if (update.status) next.status = String(update.status);
  if (update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)) {
    next.input = clipFields({ ...(previous.input || {}), ...update.rawInput });
    delete next.input.variant;
  } else if (update.rawInput != null) {
    next.input = update.rawInput;
  }
  if (Array.isArray(update.locations)) {
    next.paths = update.locations.map((item) => item?.path).filter(Boolean).map(String);
  }
  if (Array.isArray(update.content)) {
    const texts = [];
    const diffs = [];
    for (const item of update.content) {
      if (item?.type === "diff") {
        diffs.push({ path: String(item.path || ""), oldText: clip(item.oldText || ""), newText: clip(item.newText || "") });
      } else if (item?.type === "content") {
        const text = textOf(item.content);
        if (text) texts.push(text);
      }
    }
    if (texts.length) next.output = clip(texts.join("\n"));
    if (diffs.length) next.diffs = diffs;
  }
  if (update.rawOutput != null && !next.output) {
    const text = rawText(update.rawOutput);
    if (text) next.output = clip(text);
  }
  return next;
}

function setPlan(messages, entries) {
  const list = Array.isArray(entries)
    ? entries.map((entry) => ({ content: String(entry?.content ?? ""), status: String(entry?.status ?? "pending") }))
    : [];
  return editAssistant(messages, (blocks) => {
    const at = blocks.findIndex((block) => block.type === "plan");
    if (at >= 0) blocks[at] = { type: "plan", entries: list };
    else blocks.push({ type: "plan", entries: list });
  });
}

function finishTurn(messages, update, meta) {
  const info = {
    stopReason: String(update.stop_reason || "end_turn"),
    elapsedMs: Number(update.elapsed_ms) || 0,
    usage: usageOf(update.usage),
    endedAt: meta.timestamp || null,
  };
  const tail = messages.at(-1);
  if (tail?.role === "assistant" && !tail.meta) return [...messages.slice(0, -1), { ...tail, meta: info }];
  if (tail?.role === "user") return [...messages, { role: "assistant", blocks: [], meta: info }];
  return messages;
}

function rewindTo(messages, target) {
  if (!Number.isFinite(target)) return messages;
  const cut = messages.findIndex((message) => message.role === "user" && Number.isInteger(message.promptIndex) && message.promptIndex >= target);
  return cut >= 0 ? messages.slice(0, cut) : messages;
}

function unwrap(text) {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return match ? match[1] : text;
}

function clip(text, max = MAX_TEXT) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}\n…（后面还有 ${value.length - max} 字）` : value;
}

function clipFields(object) {
  const next = {};
  for (const [key, value] of Object.entries(object)) {
    next[key] = typeof value === "string" ? clip(value, MAX_FIELD) : value;
  }
  return next;
}

function isBytes(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => Number.isInteger(item) && item >= 0 && item < 256);
}

function decodeBytes(value) {
  return new TextDecoder().decode(Uint8Array.from(value));
}

function rawText(raw) {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return raw == null ? "" : String(raw);
  if (typeof raw.message === "string" && raw.error) return raw.message;
  for (const key of ["content", "Content", "text", "stdout", "output", "summary_for_prompt", "message", "Result", "NotFound", "FileNotFound"]) {
    const value = raw[key];
    if (value == null) continue;
    if (typeof value === "string") return value;
    if (isBytes(value)) return decodeBytes(value);
    if (typeof value === "object") {
      const inner = rawText(value);
      if (inner) return inner;
    }
  }
  const keys = Object.keys(raw).filter((key) => key !== "type");
  if (keys.length === 1 && raw[keys[0]] && typeof raw[keys[0]] === "object") return rawText(raw[keys[0]]);
  return JSON.stringify(raw, (_key, value) => (isBytes(value) ? decodeBytes(value) : value), 2);
}
