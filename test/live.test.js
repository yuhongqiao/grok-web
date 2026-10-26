import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server/index.js";
import { startAgent } from "../server/agent.js";
import { createHub } from "../server/hub.js";
import { createStore } from "../server/sessions.js";
import { json, listen, openStream, post } from "./helpers.js";

const live = process.env.GROK_LIVE === "1";
const turnDone = (event) => event.type === "update" && event.update.sessionUpdate === "turn_completed";
const stateIs = (match) => (event) => (event.type === "state" || event.type === "snapshot") && match(event.state);
const reply = (stream, from = 0) => stream.events.slice(from)
  .filter((event) => event.type === "update" && event.update.sessionUpdate === "agent_message_chunk")
  .map((event) => event.update.content?.text || "").join("");
function finished(stream) {
  let count = 0;
  for (const event of stream.events) {
    if (event.type === "snapshot") count = event.messages.filter((message) => message.role === "assistant" && message.meta).length;
    else if (turnDone(event)) count += 1;
  }
  return count;
}

// Talks to the real `grok agent stdio`. Every prompt avoids tools; the one that would write a
// file gets its permission request rejected. Everything it creates is removed at the end.
test("live grok: first turn, queue, rejected permission, settings, rewind points, aside", { skip: !live, timeout: 600_000 }, async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-web-live-")));
  const meta = fs.mkdtempSync(path.join(os.tmpdir(), "grok-web-live-meta-"));
  const store = createStore({
    sessionsDir: path.join(os.homedir(), ".grok", "sessions"),
    trashDir: path.join(meta, "trash"),
    projectsFile: path.join(meta, "projects.json"),
    parentDir: path.dirname(cwd),
  });
  const hub = createHub({ store, spawnAgent: () => startAgent() });
  const { server, port } = await listen(createApp({ store, hub }));
  const base = `http://127.0.0.1:${port}`;
  let stream = null;
  try {
    const project = store.createProject({ name: path.basename(cwd), cwd });
    const { sessionId } = await json(await post(base, `/api/projects/${project.encoded}/sessions`, {
      text: "不要使用任何工具，也不要读文件。只回复两个字：收到", effort: "low", permission: "ask",
    }));
    stream = openStream(base, sessionId);
    await stream.waitFor(() => finished(stream) >= 1, { timeout: 180_000 });
    const snapshot = stream.events.find((event) => event.type === "snapshot");
    const first = reply(stream) || snapshot.messages.map((message) => message.blocks?.map((block) => block.text || "").join("") || "").join("");
    assert.match(first, /收到/);
    assert.equal(fs.existsSync(path.join(store.sessionsDir, project.encoded, sessionId)), true);

    const from = stream.events.length;
    await json(await post(base, `/api/sessions/${sessionId}/prompt`, { text: "不要使用任何工具。从1数到40，每个数字单独一行。" }));
    await json(await post(base, `/api/sessions/${sessionId}/prompt`, { text: "不要使用任何工具。只回复两个字：第二" }));
    await json(await post(base, `/api/sessions/${sessionId}/prompt`, { text: "不要使用任何工具。只回复两个字：第三" }));
    const queued = await stream.waitFor(stateIs((state) => state.queue.some((entry) => entry.text.includes("第三"))), { from, timeout: 60_000 });
    const third = queued.state.queue.find((entry) => entry.text.includes("第三"));
    await json(await post(base, `/api/sessions/${sessionId}/queue/${third.id}`, { action: "remove" }));
    await stream.waitFor(() => finished(stream) >= 3, { from, timeout: 300_000 });
    const starts = stream.events.slice(from).filter((event) => event.type === "turn_start").map((event) => event.message?.text || "");
    assert.equal(starts.some((text) => text.includes("第三")), false);
    assert.match(reply(stream, from), /第二/);

    const asked = stream.events.length;
    await json(await post(base, `/api/sessions/${sessionId}/prompt`, { text: "在当前目录新建文件 note.txt，内容是 hi。直接用写文件工具，不要做别的。" }));
    const outcome = await stream.waitFor((event) => (event.type === "interaction" && event.interaction.kind === "permission") || turnDone(event), { from: asked, timeout: 240_000 });
    if (outcome.type === "interaction") {
      const reject = outcome.interaction.options.find((option) => option.kind.startsWith("reject")) || outcome.interaction.options.at(-1);
      await json(await post(base, `/api/sessions/${sessionId}/interactions/${outcome.interaction.requestId}`, { optionId: reject.optionId }));
      await stream.waitFor(turnDone, { from: asked, timeout: 120_000 });
    }
    assert.equal(fs.existsSync(path.join(cwd, "note.txt")), false);

    let state = await json(await post(base, `/api/sessions/${sessionId}/settings`, { effort: "medium" }));
    assert.equal(state.effort, "medium");
    state = await json(await post(base, `/api/sessions/${sessionId}/settings`, { mode: "plan" }));
    assert.equal(state.mode, "plan");
    state = await json(await post(base, `/api/sessions/${sessionId}/settings`, { mode: "default" }));
    assert.equal(state.mode, "default");

    const { turns } = await json(await fetch(`${base}/api/sessions/${sessionId}/turns`));
    assert.equal(turns.length >= 3, true);
    const aside = await json(await post(base, `/api/sessions/${sessionId}/btw`, { question: "一句话说说你刚才做了什么" }));
    assert.equal(aside.answer.length > 0, true);
  } finally {
    stream?.close();
    hub.stop();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const options = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
    fs.rmSync(path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(cwd)), options);
    fs.rmSync(cwd, options);
    fs.rmSync(meta, options);
  }
});
