import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { messageText } from "../client/src/transcript.js";
import { fixtureApp, json, line, listen, openStream, post, tempRoot, writeSession } from "./helpers.js";

async function setup() {
  const root = tempRoot();
  const fixture = fixtureApp(root);
  const { server, port } = await listen(fixture.app);
  const base = `http://127.0.0.1:${port}`;
  const streams = [];
  return {
    ...fixture,
    root,
    base,
    stream(id) {
      const stream = openStream(base, id);
      streams.push(stream);
      return stream;
    },
    async project(name) {
      return json(await post(base, "/api/projects", { name }));
    },
    async close() {
      for (const stream of streams) stream.close();
      fixture.hub.stop();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const turnDone = (event) => event.type === "update" && event.update.sessionUpdate === "turn_completed";
const textOf = (stream, from = 0) => stream.events.slice(from)
  .filter((event) => event.type === "update" && event.update.sessionUpdate === "agent_message_chunk")
  .map((event) => event.update.content.text).join("");
const lastState = (stream) => stream.events.filter((event) => event.type === "state" || event.type === "snapshot").at(-1).state;
// What happened before the stream connected is only in its snapshot.
const stateIs = (match) => (event) => (event.type === "state" || event.type === "snapshot") && match(event.state);
const asks = (kind) => stateIs((state) => state.interactions.some((item) => item.kind === kind));
const pick = (event, kind) => event.state.interactions.find((item) => item.kind === kind);
function finished(stream) {
  let count = 0;
  for (const event of stream.events) {
    if (event.type === "snapshot") count = event.messages.filter((message) => message.role === "assistant" && message.meta).length;
    else if (turnDone(event)) count += 1;
  }
  return count;
}
const turnsDone = (stream, count) => () => finished(stream) >= count;

test("a new session streams its first turn and the snapshot matches what Grok saved", async () => {
  const t = await setup();
  try {
    const project = await t.project("项目1");
    const created = await post(t.base, `/api/projects/${project.encoded}/sessions`, { text: "你好", effort: "low" });
    assert.equal(created.status, 201);
    const { sessionId } = await created.json();
    const stream = t.stream(sessionId);
    await stream.waitFor(turnsDone(stream, 1));
    const usage = await stream.waitFor(stateIs((state) => state.usage?.total === 1200));
    assert.equal(usage.state.effort, "low");
    assert.equal(usage.state.permission, "ask");

    const again = t.stream(sessionId);
    const snapshot = await again.waitFor((event) => event.type === "snapshot");
    assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(snapshot.messages[0].text, "你好");
    assert.equal(messageText(snapshot.messages[1]), "收到：你好");
    assert.equal(snapshot.messages[1].blocks.some((block) => block.type === "tool" && block.status === "completed"), true);
    assert.equal(snapshot.messages[1].meta.stopReason, "end_turn");

    const state = await json(await fetch(`${t.base}/api/state`));
    const listed = state.projects.find((item) => item.name === "项目1");
    assert.equal(listed.sessions[0].id, sessionId);
    assert.equal(listed.sessions[0].title, "你好");
    assert.equal(state.defaults.model, "grok-4.7");
    assert.deepEqual(state.defaults.models.map((model) => model.id), ["grok-4.7", "grok-4.6"]);
    assert.equal(state.defaults.commands.some((command) => command.name === "code-review" && command.source === "skill"), true);
  } finally {
    await t.close();
  }
});

test("cancel stops the running turn and the stop button goes away", async () => {
  const t = await setup();
  try {
    const project = await t.project("停止");
    const { sessionId } = await json(await post(t.base, `/api/projects/${project.encoded}/sessions`, { text: "慢慢说" }));
    const stream = t.stream(sessionId);
    const showsRunning = (event) => (event.type === "state" || event.type === "snapshot") && event.state?.running;
    await stream.waitFor(showsRunning);
    assert.equal((await post(t.base, `/api/sessions/${sessionId}/cancel`, {})).status, 200);
    await stream.waitFor((event) => turnDone(event) && event.update.stop_reason === "cancelled");
    await stream.waitFor((event) => event.type === "state" && event.state.running === false);
  } finally {
    await t.close();
  }
});

test("prompts sent during a turn wait in Grok's queue and can be removed or sent now", async () => {
  const t = await setup();
  try {
    const project = await t.project("排队");
    const { sessionId } = await json(await post(t.base, `/api/projects/${project.encoded}/sessions`, { text: "慢慢说" }));
    const stream = t.stream(sessionId);
    const opened = await stream.waitFor(stateIs((state) => state.running));
    assert.equal(opened.messages?.[0]?.text ?? "慢慢说", "慢慢说");
    for (const text of ["第二条", "第三条"]) {
      assert.equal((await post(t.base, `/api/sessions/${sessionId}/prompt`, { text })).status, 200);
    }
    const queued = await stream.waitFor(stateIs((state) => state.queue.length === 2));
    const third = queued.state.queue.find((entry) => entry.text === "第三条");
    assert.equal((await post(t.base, `/api/sessions/${sessionId}/queue/${third.id}`, { action: "remove" })).status, 200);
    await stream.waitFor(stateIs((state) => state.queue.length === 1));
    assert.equal((await post(t.base, `/api/sessions/${sessionId}/prompt`, { text: "插队", now: true })).status, 200);
    await stream.waitFor((event) => event.type === "turn_start" && event.message.text === "第二条", { timeout: 15_000 });
    await stream.waitFor(() => stream.events.filter(turnDone).length >= 3, { timeout: 15_000 });
    const starts = stream.events.filter((event) => event.type === "turn_start").map((event) => event.message.text);
    assert.deepEqual(starts.filter((text) => text !== "慢慢说"), ["插队", "第二条"]);
    assert.equal(stream.events.filter(turnDone)[0].update.stop_reason, "cancelled");
    const missing = await post(t.base, `/api/sessions/${sessionId}/queue/nope`, { action: "remove" });
    assert.equal(missing.status, 404);
  } finally {
    await t.close();
  }
});

test("permission, question and plan requests wait for the browser's answer", async () => {
  const t = await setup();
  try {
    const project = await t.project("批准");
    const { sessionId } = await json(await post(t.base, `/api/projects/${project.encoded}/sessions`, { text: "请读取说明", permission: "ask" }));
    const stream = t.stream(sessionId);
    const asked = await stream.waitFor(asks("permission"));
    const permission = { interaction: pick(asked, "permission") };
    assert.deepEqual(permission.interaction.options.map((option) => option.optionId), ["allow-once", "reject-once"]);
    assert.equal(permission.interaction.toolCallId, "call-read");
    assert.equal(lastState(stream).interactions.length, 1);
    const live = await json(await fetch(`${t.base}/api/state`));
    assert.equal(live.live[sessionId].waiting, true);
    await json(await post(t.base, `/api/sessions/${sessionId}/interactions/${permission.interaction.requestId}`, { optionId: "reject-once" }));
    await stream.waitFor(turnDone);
    assert.match(textOf(stream), /已拒绝/);
    assert.equal(lastState(stream).interactions.length, 0);

    let from = stream.events.length;
    await json(await post(t.base, `/api/sessions/${sessionId}/prompt`, { text: "问我一个问题" }));
    const question = await stream.waitFor((event) => event.type === "interaction" && event.interaction.kind === "question", { from });
    assert.deepEqual(question.interaction.questions[0].options.map((option) => option.label), ["红", "蓝"]);
    await json(await post(t.base, `/api/sessions/${sessionId}/interactions/${question.interaction.requestId}`, { answers: { "喜欢什么颜色？": "蓝" } }));
    await stream.waitFor(turnDone, { from });
    assert.match(textOf(stream, from), /你选了：蓝/);

    await json(await post(t.base, `/api/sessions/${sessionId}/settings`, { mode: "plan" }));
    await stream.waitFor((event) => event.type === "state" && event.state.mode === "plan", { from });
    from = stream.events.length;
    await json(await post(t.base, `/api/sessions/${sessionId}/prompt`, { text: "做个计划" }));
    let plan = await stream.waitFor((event) => event.type === "interaction" && event.interaction.kind === "plan", { from });
    assert.match(plan.interaction.plan, /写入 note\.md/);
    await json(await post(t.base, `/api/sessions/${sessionId}/interactions/${plan.interaction.requestId}`, { outcome: "revise", feedback: "再细一点" }));
    await stream.waitFor(turnDone, { from });
    assert.match(textOf(stream, from), /按意见修改：再细一点/);

    from = stream.events.length;
    await json(await post(t.base, `/api/sessions/${sessionId}/prompt`, { text: "改好了吗" }));
    plan = await stream.waitFor((event) => event.type === "interaction" && event.interaction.kind === "plan", { from });
    await json(await post(t.base, `/api/sessions/${sessionId}/interactions/${plan.interaction.requestId}`, { outcome: "approved" }));
    await stream.waitFor(turnDone, { from });
    assert.match(textOf(stream, from), /开始执行计划/);
    assert.equal(lastState(stream).mode, "default");

    const gone = await post(t.base, `/api/sessions/${sessionId}/interactions/${plan.interaction.requestId}`, { outcome: "approved" });
    assert.equal(gone.status, 404);
  } finally {
    await t.close();
  }
});

test("model, effort, permission, title, rewind, fork, btw and delete", async () => {
  const t = await setup();
  try {
    const project = await t.project("设置");
    const { sessionId } = await json(await post(t.base, `/api/projects/${project.encoded}/sessions`, { text: "第一句" }));
    const stream = t.stream(sessionId);
    await stream.waitFor(turnsDone(stream, 1));
    await json(await post(t.base, `/api/sessions/${sessionId}/prompt`, { text: "第二句" }));
    await stream.waitFor(turnsDone(stream, 2));

    let state = await json(await post(t.base, `/api/sessions/${sessionId}/settings`, { model: "grok-4.6" }));
    assert.equal(state.model, "grok-4.6");
    assert.equal(state.effort, "high");
    state = await json(await post(t.base, `/api/sessions/${sessionId}/settings`, { effort: "low" }));
    assert.equal(state.effort, "low");
    assert.equal(state.efforts.some((item) => item.id === "low"), true);
    state = await json(await post(t.base, `/api/sessions/${sessionId}/settings`, { permission: "yolo" }));
    assert.equal(state.permission, "yolo");
    assert.equal(state.loaded, false);
    const bad = await post(t.base, `/api/sessions/${sessionId}/settings`, { permission: "everything" });
    assert.equal(bad.status, 400);

    const renamed = await json(await post(t.base, `/api/sessions/${sessionId}`, { title: "新标题" }, "PATCH"));
    assert.equal(renamed.title, "新标题");
    const summary = JSON.parse(fs.readFileSync(path.join(t.sessionsDir, project.encoded, sessionId, "summary.json"), "utf8"));
    assert.equal(summary.generated_title, "新标题");

    const { turns } = await json(await fetch(`${t.base}/api/sessions/${sessionId}/turns`));
    assert.deepEqual(turns.map((turn) => turn.preview), ["第一句", "第二句"]);
    const from = stream.events.length;
    const rewound = await json(await post(t.base, `/api/sessions/${sessionId}/rewind`, { promptIndex: 1, scope: "conversation" }));
    assert.equal(rewound.promptText, "第二句");
    await stream.waitFor((event) => event.type === "reload", { from });
    const after = t.stream(sessionId);
    const snapshot = await after.waitFor((event) => event.type === "snapshot");
    assert.deepEqual(snapshot.messages.filter((message) => message.role === "user").map((message) => message.text), ["第一句"]);

    const btw = await json(await post(t.base, `/api/sessions/${sessionId}/btw`, { question: "在干嘛" }));
    assert.equal(btw.answer, "旁问回答：在干嘛");

    const forked = await json(await post(t.base, `/api/sessions/${sessionId}/fork`, {}));
    const listed = (await json(await fetch(`${t.base}/api/state`))).projects.find((item) => item.name === "设置");
    assert.equal(listed.sessions.find((item) => item.id === forked.sessionId).title, "新标题 · 分叉");

    const skills = await json(await fetch(`${t.base}/api/extensions/skills?session=${sessionId}`));
    assert.equal(skills.items[0].name, "code-review");
    const memory = await json(await fetch(`${t.base}/api/extensions/memory`));
    assert.match(memory.note, /没有开启/);

    const deleted = await fetch(`${t.base}/api/sessions/${sessionId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    await stream.waitFor((event) => event.type === "deleted");
    assert.equal(fs.existsSync(path.join(t.sessionsDir, project.encoded, sessionId)), false);
    assert.equal((await fetch(`${t.base}/api/sessions/${sessionId}/events`)).status, 404);
  } finally {
    await t.close();
  }
});

test("an existing session comes from disk and its history is not replayed live", async () => {
  const t = await setup();
  try {
    const project = await t.project("短视频");
    const sessionId = "01a16e75-d656-7ee2-a8dd-1ebfba4b3271";
    writeSession(t.sessionsDir, project.cwd, sessionId, {
      title: "改稿",
      updates: [
        line({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "改一版" }, _meta: { promptIndex: 0 } }),
        line({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "改好了" } }),
        line({ sessionUpdate: "turn_completed", stop_reason: "end_turn" }),
      ],
    });
    const stream = t.stream(sessionId);
    const snapshot = await stream.waitFor((event) => event.type === "snapshot");
    assert.equal(snapshot.state.loaded, false);
    assert.equal(snapshot.state.title, "改稿");
    assert.equal(snapshot.state.effort, "high");
    assert.equal(messageText(snapshot.messages[1]), "改好了");

    await json(await post(t.base, `/api/sessions/${sessionId}/prompt`, { text: "再改" }));
    await stream.waitFor(turnDone);
    assert.equal(textOf(stream).includes("改好了"), false);
    assert.equal(stream.events.filter((event) => event.type === "turn_start").length, 1);
    const fresh = await t.stream(sessionId).waitFor((event) => event.type === "snapshot");
    assert.deepEqual(fresh.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);

    assert.equal((await post(t.base, "/api/sessions/01a16e75-d656-7ee2-a8dd-000000000000/prompt", { text: "x" })).status, 404);
    assert.equal((await post(t.base, `/api/sessions/${sessionId}/prompt`, { text: " " })).status, 400);
    assert.equal((await post(t.base, `/api/projects/${encodeURIComponent("/nope/where")}/sessions`, { text: "x" })).status, 400);
  } finally {
    await t.close();
  }
});

test("a reconnect in the middle of a turn shows the streamed part once", async () => {
  const t = await setup();
  try {
    const project = await t.project("断线");
    const { sessionId } = await json(await post(t.base, `/api/projects/${project.encoded}/sessions`, { text: "慢慢讲" }));
    const first = t.stream(sessionId);
    await first.waitFor((event) => event.type === "update" && event.update.content?.text === "第2段。");
    const second = t.stream(sessionId);
    const snapshot = await second.waitFor((event) => event.type === "snapshot");
    assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(snapshot.messages[0].text, "慢慢讲");
    assert.match(messageText(snapshot.messages[1]), /^第1段。第2段。/);
    assert.equal(snapshot.state.running, true);
    await second.waitFor(turnDone);
  } finally {
    await t.close();
  }
});

test("only this machine's own pages may use the server", async () => {
  const t = await setup();
  const port = Number(new URL(t.base).port);
  const raw = (headers) => new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/api/state", headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  try {
    assert.equal(await raw({}), 200);
    assert.equal(await raw({ host: `localhost:${port}` }), 200);
    assert.equal(await raw({ origin: `http://127.0.0.1:${port}` }), 200);
    assert.equal(await raw({ origin: "http://127.0.0.1:5173" }), 200);
    assert.equal(await raw({ host: `evil.example:${port}` }), 403);
    assert.equal(await raw({ host: "127.0.0.1:80" }), 403);
    assert.equal(await raw({ origin: "https://evil.example" }), 403);
    assert.equal(await raw({ origin: "null" }), 403);
  } finally {
    await t.close();
  }
});
