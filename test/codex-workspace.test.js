import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { createCodexWorkspace } from "../server/codex-workspace.js";
import { tempRoot } from "./helpers.js";

test("workspace protects file revisions and paths, handles literal Git filenames and never overrides CLI permissions", async () => {
  const root = tempRoot(); const calls = [];
  const workspace = createCodexWorkspace({ watchAgent: () => () => {}, async native(method, params) {
    calls.push({ method, params });
    assert.equal(Object.hasOwn(params, "sandboxPolicy"), false); assert.equal(Object.hasOwn(params, "permissionProfile"), false);
    if (method === "fs/readFile") return { dataBase64: fs.readFileSync(params.path).toString("base64") };
    if (method === "fs/writeFile") { fs.writeFileSync(params.path, Buffer.from(params.dataBase64, "base64")); return {}; }
    if (method === "fs/readDirectory") return { entries: fs.readdirSync(params.path, { withFileTypes: true }).map((entry) => ({ fileName: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() })) };
    assert.equal(method, "command/exec"); assert.equal(params.cwd, root); assert.equal(params.command[0], "git");
    return new Promise((resolve) => execFile(params.command[0], params.command.slice(1), { cwd: root }, (error, stdout, stderr) => resolve({ exitCode: error ? Number(error.code) || 1 : 0, stdout, stderr })));
  } });
  try {
    fs.writeFileSync(path.join(root, "[note].txt"), "initial\n"); fs.writeFileSync(path.join(root, "n.txt"), "must remain untracked\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "node test-server.js" } }));
    fs.symlinkSync(os.tmpdir(), path.join(root, "outside"));
    const file = await workspace.read(root, "[note].txt"); await workspace.write(root, file.path, "edited\n", file.revision);
    await assert.rejects(workspace.write(root, file.path, "stale overwrite", file.revision), /修改/);
    await assert.rejects(workspace.read(root, "../escape"), /项目内/); await assert.rejects(workspace.tree(root, "outside"), /项目以外/);
    assert.deepEqual((await workspace.scripts(root)).scripts, { dev: "node test-server.js" });
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Isolated Test");
    await workspace.git(root, "stage", { paths: ["[note].txt"] });
    let status = await workspace.git(root, "status"); assert.equal(status.files.find((entry) => entry.path === "[note].txt").status, "A "); assert.equal(status.files.find((entry) => entry.path === "n.txt").status, "??");
    await workspace.git(root, "unstage", { paths: ["[note].txt"] });
    await workspace.git(root, "stage", { paths: ["[note].txt"] });
    await workspace.git(root, "commit", { message: "Explicit selected-file commit" });
    await workspace.git(root, "branch", { name: "browser-workspace-test" });
    fs.writeFileSync(path.join(root, "[note].txt"), "diff after commit\n"); assert.match((await workspace.git(root, "diff", { path: "[note].txt" })).diff, /diff after commit/);
    git("mv", "[note].txt", "renamed.txt"); status = await workspace.git(root, "status"); assert.equal(status.files.find((entry) => entry.path === "renamed.txt").from, "[note].txt");
    assert.equal((await workspace.tree(root, "")).entries.some((entry) => entry.fileName === ".git"), false);
    assert.ok(calls.some((entry) => entry.method === "fs/writeFile"));
  } finally { workspace.close(); }
});

test("terminal output preserves Unicode split between native output notifications", async () => {
  const root = tempRoot(); let receive; let finish;
  const workspace = createCodexWorkspace({ watchAgent(send) { receive = send; return () => {}; }, native(method) { assert.equal(method, "command/exec"); return new Promise((resolve) => { finish = resolve; }); } });
  try {
    const task = await workspace.start(root, { kind: "terminal" }); const bytes = Buffer.from("终端中文\r\n");
    for (const delta of [bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)]) receive({ method: "command/exec/outputDelta", params: { processId: task.id, stream: "stdout", deltaBase64: delta.toString("base64") } });
    assert.equal(workspace.list(root).processes[0].output, "终端中文\r\n");
    finish({ exitCode: 0, stdout: "", stderr: "" });
  } finally { workspace.close(); }
});
