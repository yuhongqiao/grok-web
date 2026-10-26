import assert from "node:assert/strict";
import test from "node:test";
import { applyUpdate, foldUpdates, messageText } from "../client/src/transcript.js";
import { line } from "./helpers.js";

const text = (value) => ({ type: "text", text: value });
const fold = (rows) => foldUpdates(rows.map((row) => JSON.stringify(row)).join("\n"));

test("a turn folds into one user message and one assistant message in order", () => {
  const messages = fold([
    line({ sessionUpdate: "user_message_chunk", content: text("看下目录"), _meta: { promptIndex: 0 } }),
    line({ sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "AAAA" }, _meta: { promptIndex: 0 } }),
    line({ sessionUpdate: "agent_thought_chunk", content: text("先列") }),
    line({ sessionUpdate: "agent_thought_chunk", content: text("一下。") }),
    line({ sessionUpdate: "tool_call", toolCallId: "c1", title: "list_dir", rawInput: { target_directory: "/p" }, _meta: { "x.ai/tool": { name: "list_dir", kind: "list" } } }),
    line({ sessionUpdate: "tool_call_update", toolCallId: "c1", title: "List `/p`", status: "completed", rawOutput: { type: "ListDir", Content: { content: "- a.txt" } } }),
    line({ sessionUpdate: "agent_message_chunk", content: text("有 ") }),
    line({ sessionUpdate: "agent_message_chunk", content: text("a.txt") }),
    line({ sessionUpdate: "turn_completed", stop_reason: "end_turn", elapsed_ms: 1234, usage: { totalTokens: 90, inputTokens: 80, outputTokens: 10, costUsdTicks: 5e9 } }, { _meta: { agentTimestampMs: 1700000000000 } }),
  ]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].images, [{ mimeType: "image/png", data: "AAAA" }]);
  assert.equal(messages[0].text, "看下目录");
  assert.equal(messages[0].promptIndex, 0);
  const [thinking, tool, answer] = messages[1].blocks;
  assert.deepEqual(thinking, { type: "thinking", text: "先列一下。" });
  assert.equal(tool.name, "list_dir");
  assert.equal(tool.kind, "list");
  assert.equal(tool.title, "List `/p`");
  assert.equal(tool.status, "completed");
  assert.equal(tool.output, "- a.txt");
  assert.deepEqual(answer, { type: "text", text: "有 a.txt" });
  assert.equal(messageText(messages[1]), "有 a.txt");
  assert.equal(messages[1].meta.elapsedMs, 1234);
  assert.equal(messages[1].meta.usage.total, 90);
  assert.equal(messages[1].meta.usage.cost, 0.5);
  assert.equal(messages[1].meta.endedAt, 1700000000000);
});

test("tool diffs, byte outputs and plan entries are kept", () => {
  const bytes = [...Buffer.from("found 2 matches")];
  const messages = fold([
    line({ sessionUpdate: "user_message_chunk", content: text("改一下"), _meta: { promptIndex: 0 } }),
    line({ sessionUpdate: "tool_call", toolCallId: "e1", title: "search_replace", rawInput: { file_path: "/p/a.js", old_string: "a", new_string: "b" }, _meta: { "x.ai/tool": { name: "search_replace", kind: "edit" } } }),
    line({ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", rawInput: { variant: "SearchReplace", file_path: "/p/a.js" }, content: [{ type: "diff", path: "/p/a.js", oldText: "a", newText: "b" }], locations: [{ path: "/p/a.js" }] }),
    line({ sessionUpdate: "tool_call", toolCallId: "g1", title: "grep", rawInput: { pattern: "x" }, _meta: { "x.ai/tool": { name: "grep", kind: "search" } } }),
    line({ sessionUpdate: "tool_call_update", toolCallId: "g1", status: "completed", rawOutput: { type: "GrepSearch", stdout: bytes, exit_code: 0 } }),
    line({ sessionUpdate: "plan", entries: [{ content: "第一步", status: "completed" }, { content: "第二步", status: "in_progress" }] }),
    line({ sessionUpdate: "plan", entries: [{ content: "第一步", status: "completed" }, { content: "第二步", status: "completed" }] }),
  ]);
  const [edit, grep, plan] = messages[1].blocks;
  assert.deepEqual(edit.diffs, [{ path: "/p/a.js", oldText: "a", newText: "b" }]);
  assert.deepEqual(edit.paths, ["/p/a.js"]);
  assert.equal(edit.input.variant, undefined);
  assert.equal(edit.input.old_string, "a");
  assert.equal(grep.output, "found 2 matches");
  assert.equal(plan.type, "plan");
  assert.deepEqual(plan.entries.map((entry) => entry.status), ["completed", "completed"]);
  assert.equal(messages[1].blocks.length, 3);
});

test("hidden prompts are skipped and a wake-up turn starts a new assistant message", () => {
  const messages = fold([
    line({ sessionUpdate: "user_message_chunk", content: text("跑测试"), _meta: { promptIndex: 0 } }),
    line({ sessionUpdate: "agent_message_chunk", content: text("开始跑") }),
    line({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }),
    line({ sessionUpdate: "user_message_chunk", content: text("<system-reminder>task done</system-reminder>"), _meta: { promptIndex: 1, hideFromScrollback: true } }),
    line({ sessionUpdate: "agent_message_chunk", content: text("测试通过") }),
    line({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }),
  ]);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "assistant"]);
  assert.equal(JSON.stringify(messages).includes("system-reminder"), false);
  assert.equal(messageText(messages[2]), "测试通过");
});

test("a rewind marker drops that prompt and everything after it", () => {
  const rows = [];
  ["甲", "乙", "丙"].forEach((word, index) => {
    rows.push(line({ sessionUpdate: "user_message_chunk", content: text(word), _meta: { promptIndex: index } }));
    rows.push(line({ sessionUpdate: "agent_message_chunk", content: text(`答${word}`) }));
    rows.push(line({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }));
  });
  rows.push(line({ sessionUpdate: "rewind_marker", target_prompt_index: 1 }));
  rows.push(line({ sessionUpdate: "user_message_chunk", content: text("丁"), _meta: { promptIndex: 1 } }));
  const messages = fold(rows);
  assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.text), ["甲", "丁"]);
});

test("a cancelled turn without output still gets a finished assistant entry", () => {
  let messages = [{ role: "user", text: "停一下", images: [], files: [] }];
  messages = applyUpdate(messages, { sessionUpdate: "turn_completed", stop_reason: "cancelled" });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].meta.stopReason, "cancelled");
  const before = messages;
  messages = applyUpdate(messages, { sessionUpdate: "current_mode_update", currentModeId: "plan" });
  assert.equal(messages, before);
});

test("applyUpdate does not mutate the previous array", () => {
  const first = applyUpdate([], { sessionUpdate: "agent_message_chunk", content: text("一") });
  const second = applyUpdate(first, { sessionUpdate: "agent_message_chunk", content: text("二") });
  assert.equal(messageText(first[0]), "一");
  assert.equal(messageText(second[0]), "一二");
});
