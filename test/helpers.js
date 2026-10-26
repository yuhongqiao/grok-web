import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { startAgent } from "../server/agent.js";
import { createHub } from "../server/hub.js";
import { createStore } from "../server/sessions.js";

export const fakeAgent = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agent.js");

export function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-web-")));
}

export function writeSession(sessionsDir, cwd, id, { title = "示例会话", updates, history, model = "grok-4.7", effort = "high" } = {}) {
  const dir = path.join(sessionsDir, encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({
    info: { id, cwd },
    generated_title: title,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
    current_model_id: model,
    reasoning_effort: effort,
    num_chat_messages: 2,
  }));
  if (updates) fs.writeFileSync(path.join(dir, "updates.jsonl"), Array.isArray(updates) ? `${updates.map((line) => JSON.stringify(line)).join("\n")}\n` : updates);
  if (history) fs.writeFileSync(path.join(dir, "chat_history.jsonl"), history);
  return dir;
}

export function line(update, extra = {}) {
  return { method: "session/update", params: { update, ...extra } };
}

export function storeFor(root, extra = {}) {
  return createStore({
    sessionsDir: path.join(root, "sessions"),
    trashDir: path.join(root, "trash"),
    projectsFile: path.join(root, "projects.json"),
    parentDir: path.join(root, "projects"),
    tempDirs: [path.join(root, "scratch")],
    ...extra,
  });
}

export function fixtureApp(root, agentPath = fakeAgent) {
  const store = storeFor(root);
  fs.mkdirSync(store.parentDir, { recursive: true });
  fs.mkdirSync(store.sessionsDir, { recursive: true });
  const env = { ...process.env, GROK_SESSIONS_DIR: store.sessionsDir };
  const hub = createHub({ store, spawnAgent: () => startAgent({ command: process.execPath, args: [agentPath], env }) });
  hub.start();
  return { store, hub, app: createApp({ store, hub }), sessionsDir: store.sessionsDir };
}

export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// Reads a session's event stream and lets a test wait for the event it needs.
export function openStream(base, sessionId) {
  const events = [];
  const waiters = [];
  const controller = new AbortController();
  const check = () => {
    for (const waiter of [...waiters]) {
      const hit = events.slice(waiter.from).find(waiter.match);
      if (hit) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(hit);
      }
    }
  };
  const done = (async () => {
    const response = await fetch(`${base}/api/sessions/${sessionId}/events`, { signal: controller.signal });
    if (!response.ok) throw new Error(`stream ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk.split("\n").filter((row) => row.startsWith("data: ")).map((row) => row.slice(6)).join("\n");
        if (data) {
          events.push(JSON.parse(data));
          check();
        }
        index = buffer.indexOf("\n\n");
      }
    }
  })().catch((error) => {
    if (error.name !== "AbortError") throw error;
  });
  return {
    events,
    done,
    close: () => controller.abort(),
    waitFor(match, { from = 0, timeout = 8000 } = {}) {
      return new Promise((resolve, reject) => {
        const waiter = { match, from, resolve };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting; saw ${events.map((event) => event.type + (event.update ? `:${event.update.sessionUpdate}` : "")).join(", ")}`));
        }, timeout);
        waiters.push(waiter);
        check();
      });
    },
  };
}

export async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${body.error}`);
  return body;
}

export function post(base, url, body, method = "POST") {
  return fetch(`${base}${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}
