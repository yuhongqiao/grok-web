import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { createCodexHub } from "../server/codex.js";
import { startCodexAgent } from "../server/codex-agent.js";
import { createCodexWorkspace } from "../server/codex-workspace.js";
import { createBrowserLab } from "../server/codex-browser.js";
import { createHub } from "../server/hub.js";
import { startAgent } from "../server/agent.js";
import { fakeAgent, listen, storeFor, tempRoot } from "./helpers.js";

export async function codexFixture() {
  const root = tempRoot();
  const cwd = path.join(root, "codex-project");
  fs.mkdirSync(cwd);
  const store = storeFor(root);
  fs.mkdirSync(store.sessionsDir, { recursive: true });
  const hub = createHub({ store, spawnAgent: () => startAgent({ command: process.execPath, args: [fakeAgent], env: { ...process.env, GROK_SESSIONS_DIR: store.sessionsDir } }) });
  const fakeHome = path.join(root, "fake-codex");
  const newCodex = () => createCodexHub({
    projectsFile: path.join(root, "codex-projects.json"),
    spawnAgent: () => startCodexAgent({ command: process.execPath, args: [fileURLToPath(new URL("./fake-codex.js", import.meta.url))], env: { ...process.env, CODEX_FAKE_HOME: fakeHome } }),
  });
  const codex = newCodex();
  const workspace = createCodexWorkspace(codex);
  const browserLab = createBrowserLab({ dataDir: path.join(root, "browser"), headless: true });
  const { server, port } = await listen(createApp({ store, hub, codex, workspace, browser: browserLab, browserToken: "isolated-test-token" }));
  return {
    root, cwd, fakeHome, codex, newCodex, store, workspace, browserLab, base: `http://127.0.0.1:${port}`,
    async close() { workspace.close(); codex.stop(); hub.stop(); await browserLab.stop(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}

export async function waitFor(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Codex fixture");
}
