import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startAgent } from "../server/agent.js";

test("a missing Grok command rejects initialization promptly", { timeout: 3000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-web-agent-"));
  const agent = startAgent({ command: path.join(root, "missing-grok") });
  t.after(() => {
    agent.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(agent.ready, /ENOENT/);
  await agent.exited;
  assert.equal(agent.alive, false);
  await assert.rejects(agent.request("session/new", {}), /ENOENT/);
});
