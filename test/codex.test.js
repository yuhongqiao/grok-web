import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { startCodexAgent } from "../server/codex-agent.js";
import { applyThreadEvent } from "../client/src/codex/protocol.js";
import { codexInput } from "../server/codex-input.js";
import { interactionResult } from "../server/codex-interactions.js";
import { json, post } from "./helpers.js";
import { codexFixture, waitFor } from "./codex-helpers.js";

test("Codex starts independently and streams a conversation without duplicate output after reconnect", async () => {
  const f = await codexFixture();
  try {
    const state = await json(await fetch(`${f.base}/api/codex/state`));
    assert.equal(state.account.authenticated, true);
    assert.equal(state.models[0].model, "codex-test");
    const created = await json(await post(f.base, "/api/codex/threads", { cwd: f.cwd }));
    const id = created.thread.id;
    await json(await post(f.base, `/api/codex/threads/${id}/prompt`, { text: "中文流式回复", model: "codex-other", effort: "low" }));
    await waitFor(() => !f.codex.snapshot(id).busy);
    const snapshot = f.codex.snapshot(id);
    assert.equal(snapshot.thread.turns.length, 1);
    assert.equal(snapshot.thread.turns[0].items.filter((item) => item.type === "agentMessage").length, 1);
    assert.equal(snapshot.thread.turns[0].items.at(-1).text, "收到：中文流式回复");
    assert.equal(snapshot.settings.model, "codex-other");
    assert.equal((await f.codex.list()).threads[0].id, id);
    const controller = new AbortController();
    const response = await fetch(`${f.base}/api/codex/threads/${id}/events`, { signal: controller.signal });
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const { value } = await response.body.getReader().read();
    const first = JSON.parse(new TextDecoder().decode(value).split("\n")[0].slice(6));
    assert.equal(first.type, "snapshot");
    assert.deepEqual(first.thread.turns, snapshot.thread.turns);
    controller.abort();
    await json(await post(f.base, `/api/codex/threads/${id}`, { name: "独立 Codex 会话" }, "PATCH"));
    assert.equal(f.codex.snapshot(id).thread.name, "独立 Codex 会话");
    const grokState = await json(await fetch(`${f.base}/api/state`));
    assert.equal(grokState.projects.some((project) => project.sessions.some((session) => session.id === id)), false);
    await json(await fetch(`${f.base}/api/codex/threads/${id}`, { method: "DELETE" }));
    assert.equal((await f.codex.list()).threads.length, 0);
    assert.equal(fs.existsSync(f.cwd), true);
  } finally { await f.close(); }
});

test("Codex approvals and questions survive reopening and resolve only after an answer", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    for (const [text, body, expected] of [
      ["approval", { decision: "decline" }, "已拒绝"],
      ["file approval", { decision: "accept" }, "已允许"],
      ["permissions", { decision: "decline" }, "已拒绝"],
      ["question", { answers: { choice: "绿色" } }, "回答：绿色"],
    ]) {
      await f.codex.prompt(thread.id, { text });
      const request = await waitFor(() => f.codex.snapshot(thread.id).interactions[0]);
      await f.codex.open(thread.id);
      assert.equal(f.codex.snapshot(thread.id).interactions.length, 1);
      assert.equal(f.codex.snapshot(thread.id).busy, true);
      const result = await post(f.base, `/api/codex/threads/${thread.id}/interactions/${request.id}`, body);
      assert.equal(result.status, 200);
      await waitFor(() => !f.codex.snapshot(thread.id).busy);
      assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, expected);
      assert.equal(f.codex.snapshot(thread.id).interactions.length, 0);
    }
  } finally { await f.close(); }
});

test("Codex accepts only one concurrent answer to the same approval", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "approval" });
    const request = await waitFor(() => f.codex.snapshot(thread.id).interactions[0]);
    const results = await Promise.allSettled([
      f.codex.answer(thread.id, request.id, { decision: "accept" }),
      f.codex.answer(thread.id, request.id, { decision: "decline" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.status, 409);
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, "已允许");
  } finally { await f.close(); }
});

test("Codex invalidates old approvals and pauses its queue on immediate CLI replacement", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "approval" });
    const request = await waitFor(() => f.codex.snapshot(thread.id).interactions[0]);
    await f.codex.prompt(thread.id, { text: "held after immediate restart", delivery: "queue" });
    f.codex.stop();
    await f.codex.state();
    const snapshot = f.codex.snapshot(thread.id);
    assert.equal(snapshot.thread.status.type, "notLoaded");
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.queuePaused, true);
    assert.equal(snapshot.queue.length, 1);
    assert.deepEqual(snapshot.interactions, []);
    await assert.rejects(f.codex.answer(thread.id, request.id, { decision: "accept" }), { status: 409 });
    await f.codex.open(thread.id);
    assert.equal(f.codex.snapshot(thread.id).thread.turns[0].status, "interrupted");
    await f.codex.queueAction(thread.id, "all", "resume");
    await waitFor(() => f.codex.snapshot(thread.id).thread.turns.length === 2 && !f.codex.snapshot(thread.id).busy);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, "收到：held after immediate restart");
  } finally { await f.close(); }
});

test("Codex handles a completed turn arriving before its RPC response, cancellation, and send errors", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "fast" });
    assert.equal(f.codex.snapshot(thread.id).busy, false);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).status, "completed");
    await assert.rejects(f.codex.prompt(thread.id, { text: "fail" }), /provider unavailable/);
    assert.equal(f.codex.snapshot(thread.id).busy, false);
    await f.codex.prompt(thread.id, { text: "slow task" });
    await assert.rejects(f.codex.prompt(thread.id, { text: "another" }), /正在运行/);
    await f.codex.cancel(thread.id);
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).status, "interrupted");
    await assert.rejects(f.codex.create({ cwd: path.join(f.root, "missing") }), /目录不存在/);
  } finally { await f.close(); }
});

test("Codex recovers persisted history and clears pending controls after the CLI exits", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "hello" });
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    f.codex.stop();
    await waitFor(() => f.codex.snapshot(thread.id).thread.status.type === "notLoaded");
    await f.codex.open(thread.id);
    assert.equal(f.codex.snapshot(thread.id).thread.turns[0].items.at(-1).text, "收到：hello");
    await f.codex.prompt(thread.id, { text: "crash" });
    await waitFor(() => f.codex.snapshot(thread.id).thread.status.type === "notLoaded");
    assert.equal(f.codex.snapshot(thread.id).busy, false);
    assert.deepEqual(f.codex.snapshot(thread.id).interactions, []);
    assert.equal((await f.codex.state()).account.authenticated, true);
    await f.codex.open(thread.id);
    await f.codex.prompt(thread.id, { text: "continue after restart" });
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, "收到：continue after restart");
  } finally { await f.close(); }
});

test("Codex hydrates all pages of a paginated CLI history", async () => {
  const f = await codexFixture();
  try {
    await f.codex.state();
    const saved = { id: "persisted-thread", cwd: f.cwd, model: "codex-test", historyMode: "paginated", turns: Array.from({ length: 5 }, (_, index) => ({ id: `turn-${index}`, status: "completed", items: [{ id: `message-${index}`, type: "agentMessage", text: `reply ${index}` }] })) };
    fs.writeFileSync(path.join(f.fakeHome, `${saved.id}.json`), JSON.stringify(saved));
    await f.codex.open(saved.id);
    assert.equal(f.codex.snapshot(saved.id).thread.turns.length, 5);
    assert.equal(f.codex.snapshot(saved.id).thread.turns[4].items[0].text, "reply 4");
  } finally { await f.close(); }
});

test("the Codex reducer preserves streamed output when a completion has no items", () => {
  const original = { id: "t", turns: [{ id: "turn", status: "inProgress", items: [] }] };
  const delta = applyThreadEvent(original, { method: "item/agentMessage/delta", params: { threadId: "t", turnId: "turn", itemId: "i", delta: "你好" } });
  const complete = applyThreadEvent(delta, { method: "turn/completed", params: { threadId: "t", turn: { id: "turn", status: "completed", items: [] } } });
  assert.equal(complete.turns[0].items[0].text, "你好");
  assert.equal(original.turns[0].items.length, 0);
});

test("a missing Codex executable rejects initialization without hanging", async () => {
  const agent = startCodexAgent({ command: "/missing-codex-for-test" });
  await assert.rejects(agent.ready, /无法启动 Codex/);
  await agent.exited;
});

test("Codex accepts images, UTF-8 attachments, file mentions and native skill / plan input", async () => {
  const f = await codexFixture();
  try {
    fs.writeFileSync(path.join(f.cwd, "readme.txt"), "synthetic file");
    const { thread } = await f.codex.create({ cwd: f.cwd });
    const skills = await json(await fetch(`${f.base}/api/codex/skills?cwd=${encodeURIComponent(f.cwd)}`));
    const files = await json(await fetch(`${f.base}/api/codex/files?cwd=${encodeURIComponent(f.cwd)}&q=readme`));
    assert.equal(files.files[0].path, "readme.txt");
    await f.codex.prompt(thread.id, { text: "请读 @readme.txt", attachments: [
      { name: "中文.txt", mimeType: "text/plain", data: Buffer.from("这是隔离测试内容").toString("base64") },
      { name: "tiny.png", mimeType: "image/png", data: Buffer.from("synthetic image bytes").toString("base64") },
    ], skills: [skills.skills[0].path], collaborationMode: "plan", model: "codex-other", effort: "high" });
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    const input = f.codex.snapshot(thread.id).thread.turns[0].items[0].content;
    assert.deepEqual(input.map((part) => part.type), ["text", "mention", "text", "image", "skill"]);
    assert.match(input[2].text, /这是隔离测试内容/);
    assert.match(input[3].url, /^data:image\/png;base64,/);
    const persisted = JSON.parse(fs.readFileSync(path.join(f.fakeHome, `${thread.id}.json`)));
    assert.equal(persisted.collaborationMode.mode, "plan");
    assert.equal(persisted.collaborationMode.settings.model, "codex-other");
    assert.equal(persisted.collaborationMode.settings.developer_instructions, null);
    await assert.rejects(f.codex.prompt(thread.id, { text: "hello", skills: ["/invented-skill"] }), /已不可用/);
    for (const file of [
      { name: "unsupported.pdf", mimeType: "application/pdf", data: Buffer.from("pdf").toString("base64") },
      { name: "binary.dat", data: Buffer.from([0, 255]).toString("base64") },
      { name: "bad.txt", mimeType: "text/plain", data: "not base64!" },
    ]) assert.throws(() => codexInput({ attachments: [file] }, f.cwd));
    assert.equal(codexInput({ attachments: [{ name: "only.txt", data: "aGk=" }] }, f.cwd)[0].text, "附件：only.txt\nhi");
  } finally { await f.close(); }
});

test("Codex queues messages in order, steers only the expected turn and pauses after cancellation", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    const { turnId } = await f.codex.prompt(thread.id, { text: "slow first" });
    await f.codex.prompt(thread.id, { text: "queued second", delivery: "queue" });
    const removed = await f.codex.prompt(thread.id, { text: "removed third", delivery: "queue" });
    await f.codex.queueAction(thread.id, removed.entryId, "remove");
    await f.codex.prompt(thread.id, { text: "immediate supplement", delivery: "steer", expectedTurnId: turnId });
    await assert.rejects(f.codex.prompt(thread.id, { text: "wrong turn", delivery: "steer", expectedTurnId: "outdated" }), /任务已改变/);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.length, 1);
    assert.equal(f.codex.snapshot(thread.id).thread.turns[0].items.filter((item) => item.type === "userMessage").length, 2);
    await f.codex.cancel(thread.id);
    assert.equal(f.codex.snapshot(thread.id).queuePaused, true);
    assert.equal(f.codex.snapshot(thread.id).queue.length, 1);
    await f.codex.queueAction(thread.id, "all", "resume");
    await waitFor(() => f.codex.snapshot(thread.id).thread.turns.length === 2 && !f.codex.snapshot(thread.id).busy);
    assert.equal(f.codex.snapshot(thread.id).thread.turns[1].items[0].content[0].text, "queued second");
    assert.equal(f.codex.snapshot(thread.id).queue.length, 0);
    await f.codex.prompt(thread.id, { text: "hello" });
    await f.codex.prompt(thread.id, { text: "automatically after hello", delivery: "queue" });
    await waitFor(() => f.codex.snapshot(thread.id).thread.turns.length === 4 && !f.codex.snapshot(thread.id).busy);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, "收到：automatically after hello");
  } finally { await f.close(); }
});

test("failed queued messages remain available and do not start later messages", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "hello" });
    const first = await f.codex.prompt(thread.id, { text: "fail", delivery: "queue" });
    await f.codex.prompt(thread.id, { text: "after failure", delivery: "queue" });
    await waitFor(() => f.codex.snapshot(thread.id).queuePaused);
    const snapshot = f.codex.snapshot(thread.id);
    assert.equal(snapshot.queue.length, 2);
    assert.match(snapshot.queue[0].error, /provider unavailable/);
    assert.equal(snapshot.thread.turns.length, 1);
    await assert.rejects(f.codex.archive(thread.id), /移除排队/);
    await f.codex.queueAction(thread.id, first.entryId, "remove");
    await f.codex.queueAction(thread.id, "all", "resume");
    await waitFor(() => f.codex.snapshot(thread.id).thread.turns.length === 2 && !f.codex.snapshot(thread.id).busy);
    assert.match(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, /after failure/);
  } finally { await f.close(); }
});

test("Codex forks through a chosen turn, compacts, and restores archived history without changing files", async () => {
  const f = await codexFixture();
  try {
    const marker = path.join(f.cwd, "marker.txt"); fs.writeFileSync(marker, "unchanged");
    const { thread } = await f.codex.create({ cwd: f.cwd });
    for (const text of ["one", "two"]) { await f.codex.prompt(thread.id, { text }); await waitFor(() => !f.codex.snapshot(thread.id).busy); }
    const lastTurnId = f.codex.snapshot(thread.id).thread.turns[0].id;
    const forked = await json(await post(f.base, `/api/codex/threads/${thread.id}/fork`, { lastTurnId }));
    assert.notEqual(forked.thread.id, thread.id);
    assert.equal(forked.thread.turns.length, 1);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.length, 2);
    await json(await post(f.base, `/api/codex/threads/${forked.thread.id}/compact`, {}));
    assert.equal(f.codex.snapshot(forked.thread.id).busy, true);
    await assert.rejects(f.codex.archive(forked.thread.id), /请先停止/);
    await waitFor(() => !f.codex.snapshot(forked.thread.id).busy);
    assert.equal(f.codex.snapshot(forked.thread.id).thread.turns.at(-1).items[0].type, "contextCompaction");
    await f.codex.archive(forked.thread.id);
    const archives = await json(await fetch(`${f.base}/api/codex/threads?archived=true`));
    assert.equal(archives.threads[0].id, forked.thread.id);
    await json(await post(f.base, `/api/codex/threads/${forked.thread.id}/restore`, {}));
    assert.equal((await f.codex.list()).threads.some((entry) => entry.id === forked.thread.id), true);
    assert.equal(fs.readFileSync(marker, "utf8"), "unchanged");
  } finally { await f.close(); }
});

test("Codex renders persisted local-image attachments after restoring history", async () => {
  const f = await codexFixture();
  try {
    await f.codex.state();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9XkAAAAASUVORK5CYII=", "base64");
    const file = path.join(f.cwd, "saved.png"); fs.writeFileSync(file, bytes);
    const saved = { id: "image-history", cwd: f.cwd, model: "codex-test", turns: [{ id: "turn", status: "completed", items: [{ id: "user-image", type: "userMessage", content: [{ type: "localImage", path: file }] }] }] };
    fs.writeFileSync(path.join(f.fakeHome, `${saved.id}.json`), JSON.stringify(saved));
    const image = await fetch(`${f.base}/api/codex/threads/${saved.id}/images/user-image/0`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  } finally { await f.close(); }
});

test("Codex preserves a paused queue when its CLI process exits", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "crash" });
    await f.codex.prompt(thread.id, { text: "held after restart", delivery: "queue" });
    await waitFor(() => f.codex.snapshot(thread.id).thread.status.type === "notLoaded");
    assert.equal(f.codex.snapshot(thread.id).queuePaused, true);
    assert.equal(f.codex.snapshot(thread.id).queue.length, 1);
    await f.codex.open(thread.id);
    await f.codex.queueAction(thread.id, "all", "resume");
    await waitFor(() => f.codex.snapshot(thread.id).thread.turns.length === 2 && !f.codex.snapshot(thread.id).busy);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, "收到：held after restart");
  } finally { await f.close(); }
});

test("Codex restores queues after a service restart, keeps attachments while editing, and reorders before resuming", async () => {
  const f = await codexFixture();
  let recovered;
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "slow first" });
    const a = await f.codex.prompt(thread.id, { text: "queued A", delivery: "queue", attachments: [{ name: "note.txt", data: Buffer.from("retained attachment").toString("base64") }] });
    const b = await f.codex.prompt(thread.id, { text: "queued B", delivery: "queue" });
    await f.codex.cancel(thread.id);
    f.codex.stop();
    await waitFor(() => f.codex.snapshot(thread.id).thread.status.type === "notLoaded");
    const file = path.join(f.root, "codex-queues", `${thread.id}.json`);
    const pending = JSON.parse(fs.readFileSync(file, "utf8"));
    pending[0].sending = true; // Isolated uncertain-send recovery state.
    fs.writeFileSync(file, JSON.stringify(pending));
    recovered = f.newCodex();
    await recovered.open(thread.id);
    assert.equal(recovered.snapshot(thread.id).queuePaused, true);
    assert.equal(recovered.snapshot(thread.id).queue.length, 2);
    assert.match(recovered.snapshot(thread.id).queue[0].error, /结果未确认/);
    await recovered.queueAction(thread.id, a.entryId, "edit", undefined, "edited A");
    await recovered.queueAction(thread.id, b.entryId, "up");
    assert.equal(recovered.snapshot(thread.id).queue[0].text, "queued B");
    await recovered.queueAction(thread.id, "all", "resume");
    await waitFor(() => recovered.snapshot(thread.id).thread.turns.length === 3 && !recovered.snapshot(thread.id).busy && !recovered.snapshot(thread.id).queue.length);
    const turns = recovered.snapshot(thread.id).thread.turns;
    assert.equal(turns[1].items[0].content[0].text, "queued B");
    assert.equal(turns[2].items[0].content[0].text, "edited A");
    assert.match(turns[2].items[0].content[1].text, /retained attachment/);
    assert.equal(fs.existsSync(file), false);
  } finally { recovered?.stop(); await f.close(); }
});

test("Codex edits and retries in a branch, preserves attachments, and reverts paginated history without reverting files", async () => {
  const f = await codexFixture();
  try {
    const marker = path.join(f.cwd, "marker.txt"); fs.writeFileSync(marker, "current files");
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "one", attachments: [{ name: "note.txt", data: Buffer.from("original attachment").toString("base64") }] });
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    for (const text of ["two", "three"]) { await f.codex.prompt(thread.id, { text }); await waitFor(() => !f.codex.snapshot(thread.id).busy); }
    const [first, second] = f.codex.snapshot(thread.id).thread.turns;
    const edited = await json(await post(f.base, `/api/codex/threads/${thread.id}/turns/${first.id}/revise`, { action: "edit", text: "edited one" }));
    await waitFor(() => !f.codex.snapshot(edited.thread.id).busy);
    const content = f.codex.snapshot(edited.thread.id).thread.turns[0].items[0].content;
    assert.equal(content[0].text, "edited one");
    assert.match(content[1].text, /original attachment/);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.length, 3);
    const retried = await f.codex.revise(thread.id, second.id, { action: "retry" });
    await waitFor(() => !f.codex.snapshot(retried.thread.id).busy);
    assert.equal(f.codex.snapshot(retried.thread.id).thread.turns.length, 2);
    assert.equal(f.codex.snapshot(retried.thread.id).thread.turns[1].items[0].content[0].text, "two");
    const failed = await f.codex.revise(thread.id, first.id, { action: "edit", text: "fail" });
    assert.match(failed.sendError, /provider unavailable/);
    assert.equal(failed.queuePaused, true);
    assert.equal(failed.queue[0].text, "fail");
    const reverted = await f.codex.revise(thread.id, second.id, { action: "revert" });
    assert.equal(reverted.thread.turns.length, 1);
    assert.equal(reverted.busy, false);
    assert.equal(fs.readFileSync(marker, "utf8"), "current files");
    const legacy = { ...thread, id: "legacy-history", historyMode: "legacy", turns: [first, second] };
    fs.writeFileSync(path.join(f.fakeHome, `${legacy.id}.json`), JSON.stringify(legacy));
    await assert.rejects(f.codex.revise(legacy.id, second.id, { action: "revert" }), /旧版历史/);
    const legacyBranch = await f.codex.revise(legacy.id, second.id, { action: "retry" });
    await waitFor(() => !f.codex.snapshot(legacyBranch.thread.id).busy);
    assert.equal(f.codex.snapshot(legacy.id).thread.turns.length, 2);
    assert.equal(f.codex.snapshot(legacyBranch.thread.id).thread.turns.length, 2);
  } finally { await f.close(); }
});

test("Codex searches the full history and saves settings or skill configuration without starting a turn", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "generic opening" });
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    await f.codex.prompt(thread.id, { text: "unique historical needle" });
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    const found = await json(await fetch(`${f.base}/api/codex/threads?q=historical`));
    assert.equal(found.threads[0].id, thread.id);
    assert.equal((await f.codex.list("", true, "historical")).threads.length, 0);
    await json(await post(f.base, `/api/codex/threads/${thread.id}/settings`, { model: "codex-other", effort: "high", mode: "read-only", collaborationMode: "plan" }, "PATCH"));
    assert.equal(f.codex.snapshot(thread.id).thread.turns.length, 2);
    assert.equal(f.codex.snapshot(thread.id).settings.model, "codex-other");
    f.codex.stop();
    await waitFor(() => f.codex.snapshot(thread.id).thread.status.type === "notLoaded");
    await f.codex.open(thread.id);
    assert.equal(f.codex.snapshot(thread.id).settings.sandbox.type, "readOnly");
    assert.equal(f.codex.snapshot(thread.id).settings.collaborationMode, "plan");
    const skill = (await f.codex.skills(f.cwd)).skills[0];
    const catalog = await json(await post(f.base, "/api/codex/skills", { cwd: f.cwd, path: skill.path, enabled: false }, "PATCH"));
    assert.equal(catalog.skills[0].enabled, false);
    await assert.rejects(f.codex.prompt(thread.id, { text: "hello", skills: [skill.path] }), /已不可用/);
    await f.codex.skillConfig(f.cwd, skill.path, true);
    assert.equal((await f.codex.skills(f.cwd, true)).skills[0].enabled, true);
  } finally { await f.close(); }
});

test("Codex lists native permission profiles and preserves independent sandbox and approval settings", async () => {
  const f = await codexFixture();
  try {
    const catalog = await json(await fetch(`${f.base}/api/codex/permissions?cwd=${encodeURIComponent(f.cwd)}`));
    assert.equal(catalog.supported, true);
    assert.deepEqual(catalog.profiles.map((entry) => entry.id), [":read-only", ":workspace", ":danger-full-access", "project-test", "blocked-test"]);
    assert.equal(catalog.profiles.at(-1).allowed, false);
    const { thread } = await f.codex.create({ cwd: f.cwd, permissions: "project-test", approvalPolicy: "untrusted" });
    const original = structuredClone(f.codex.snapshot(thread.id).settings);
    assert.equal(original.sandbox.networkAccess, true);
    assert.deepEqual(original.sandbox.writableRoots, [f.cwd]);
    await f.codex.settings(thread.id, { mode: "default", approvalPolicy: "default", model: "codex-other" });
    assert.deepEqual(f.codex.snapshot(thread.id).settings.sandbox, original.sandbox);
    assert.equal(f.codex.snapshot(thread.id).settings.approvalPolicy, "untrusted");
    await f.codex.settings(thread.id, { approvalPolicy: "never" });
    assert.equal(f.codex.snapshot(thread.id).settings.approvalPolicy, "never");
    assert.deepEqual(f.codex.snapshot(thread.id).settings.sandbox, original.sandbox);
    await f.codex.settings(thread.id, { mode: "read-only" });
    assert.equal(f.codex.snapshot(thread.id).settings.sandbox.type, "readOnly");
    assert.equal(f.codex.snapshot(thread.id).settings.approvalPolicy, "never");
    assert.equal(f.codex.snapshot(thread.id).thread.turns.length, 0);
    for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
      const created = await f.codex.create({ cwd: f.cwd, mode, approvalPolicy: "untrusted" });
      assert.equal(created.settings.sandbox.type, { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[mode]);
      assert.equal(created.settings.approvalPolicy, "untrusted");
    }
    fs.writeFileSync(path.join(f.fakeHome, "legacy-permissions"), "");
    assert.deepEqual(await f.codex.permissions(f.cwd), { profiles: [], supported: false });
  } finally { await f.close(); }
});

test("Codex retains profile and granular approvals through queued turns, retry and reconnect", async () => {
  const f = await codexFixture();
  try {
    const granular = { granular: { sandbox_approval: true, rules: false, mcp_elicitations: true, request_permissions: false, skill_approval: true } };
    const { thread } = await f.codex.create({ cwd: f.cwd, permissions: ":read-only", approvalPolicy: "on-request" });
    await f.codex.prompt(thread.id, { text: "slow first" });
    await f.codex.prompt(thread.id, { text: "queued profile", delivery: "queue", permissions: "project-test", approvalPolicy: granular });
    assert.equal(f.codex.snapshot(thread.id).settings.activePermissionProfile.id, ":read-only");
    await waitFor(() => !f.codex.snapshot(thread.id).busy && f.codex.snapshot(thread.id).thread.turns.length === 2 && !f.codex.snapshot(thread.id).queue.length, 8000);
    assert.equal(f.codex.snapshot(thread.id).settings.activePermissionProfile.id, "project-test");
    assert.equal(f.codex.snapshot(thread.id).settings.sandbox.networkAccess, true);
    assert.deepEqual(f.codex.snapshot(thread.id).settings.approvalPolicy, granular);
    const sourceTurn = f.codex.snapshot(thread.id).thread.turns.at(-1);
    const branch = await f.codex.revise(thread.id, sourceTurn.id, { action: "retry", permissions: ":danger-full-access", approvalPolicy: "untrusted" });
    await waitFor(() => !f.codex.snapshot(branch.thread.id).busy);
    assert.equal(f.codex.snapshot(branch.thread.id).settings.sandbox.type, "dangerFullAccess");
    assert.equal(f.codex.snapshot(branch.thread.id).settings.approvalPolicy, "untrusted");
    assert.deepEqual(f.codex.snapshot(thread.id).settings.approvalPolicy, granular);
    f.codex.stop();
    await waitFor(() => f.codex.snapshot(thread.id).thread.status.type === "notLoaded");
    await f.codex.open(thread.id);
    assert.equal(f.codex.snapshot(thread.id).settings.activePermissionProfile.id, "project-test");
    assert.deepEqual(f.codex.snapshot(thread.id).settings.approvalPolicy, granular);
  } finally { await f.close(); }
});

test("Codex rejects invalid permissions and incompatible selections without changing the session", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    const original = structuredClone(f.codex.snapshot(thread.id).settings);
    for (const body of [{ mode: "external-sandbox" }, { mode: "toString" }, { permissions: "" }, { permissions: {} }, { permissions: ":workspace", mode: "workspace-write" }, { approvalPolicy: "on-failure" }, { approvalPolicy: null }, { approvalPolicy: { granular: {} } }, { approvalPolicy: { granular: { sandbox_approval: true, rules: true, mcp_elicitations: "yes" } } }, { approvalPolicy: { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true, extra: true } } }]) {
      const response = await post(f.base, `/api/codex/threads/${thread.id}/settings`, body, "PATCH");
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    await assert.rejects(f.codex.settings(thread.id, { permissions: "blocked-test" }), /not allowed/);
    assert.deepEqual(f.codex.snapshot(thread.id).settings, original);
    assert.equal(f.codex.snapshot(thread.id).thread.turns.length, 0);
  } finally { await f.close(); }
});

test("Codex validates MCP forms and approval choices, and can skip questions or stop from approval", async () => {
  const f = await codexFixture();
  try {
    const { thread } = await f.codex.create({ cwd: f.cwd });
    await f.codex.prompt(thread.id, { text: "mcp form" });
    let request = await waitFor(() => f.codex.snapshot(thread.id).interactions[0]);
    await assert.rejects(f.codex.answer(thread.id, request.id, { action: "accept", content: { name: "test", count: "3", choice: "blue" } }), /数量/);
    assert.equal(f.codex.snapshot(thread.id).interactions.length, 1);
    await f.codex.answer(thread.id, request.id, { action: "accept", content: { name: "test", count: 3, choice: "blue", remember: true } });
    await waitFor(() => !f.codex.snapshot(thread.id).busy);
    assert.match(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, /"count":3/);
    for (const [text, body, expected] of [["restricted approval", { decision: "accept" }, "已允许"], ["approval", { decision: "acceptForSession" }, "已允许"], ["question", { skip: true }, "已跳过"], ["approval", { decision: "cancel" }, "已拒绝"]]) {
      await f.codex.prompt(thread.id, { text });
      request = await waitFor(() => f.codex.snapshot(thread.id).interactions[0]);
      if (text === "restricted approval") await assert.rejects(f.codex.answer(thread.id, request.id, { decision: "acceptForSession" }), /不支持/);
      await f.codex.answer(thread.id, request.id, body);
      await waitFor(() => !f.codex.snapshot(thread.id).busy);
      assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).items.at(-1).text, expected);
    }
    assert.equal(f.codex.snapshot(thread.id).thread.turns.at(-1).status, "interrupted");
  } finally { await f.close(); }
});

test("Codex checks MCP email, URI, date and date-time formats before accepting a form", () => {
  for (const [format, valid, invalid] of [
    ["email", ["test@example.com"], ["not-an-email", "a@@example.com", "a b@example.com"]],
    ["uri", ["https://example.com/path", "mailto:test@example.com"], ["relative/path", "https://"]],
    ["date", ["2024-02-29", "2026-10-27"], ["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-01"]],
    ["date-time", ["2026-10-27T12:30:59Z", "2024-02-29T12:30:59.123+08:00"], ["2026-02-29T12:30:00Z", "2026-10-27T24:00:00Z", "2026-10-27T12:30:00", "2026-10-27T12:30:00+25:00"]],
  ]) {
    const request = { method: "mcpServer/elicitation/request", params: { mode: "form", requestedSchema: { type: "object", required: ["value"], properties: { value: { type: "string", title: format, format } } } } };
    for (const value of invalid) assert.throws(() => interactionResult(request, { action: "accept", content: { value } }), { status: 400 }, `${format}: ${value}`);
    for (const value of valid) assert.equal(interactionResult(request, { action: "accept", content: { value } }).content.value, value);
  }
});
