import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { HttpError } from "./sessions.js";

export function workspaceRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new HttpError(400, "请选择项目的完整路径");
  try { const root = fs.realpathSync(value); if (fs.statSync(root).isDirectory()) return root; } catch {}
  throw new HttpError(400, "项目目录不存在");
}

function inside(root, relative = "") {
  if (typeof relative !== "string" || relative.includes("\0")) throw new HttpError(400, "文件路径无效");
  const file = path.resolve(root, relative);
  const contained = (target) => target === root || target.startsWith(`${root}${path.sep}`);
  if (!contained(file)) throw new HttpError(400, "文件必须位于当前项目内");
  let real;
  try { real = fs.realpathSync(file); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    let parent = path.dirname(file);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    real = path.resolve(fs.realpathSync(parent), path.relative(parent, file));
  }
  if (!contained(real)) throw new HttpError(400, "文件链接指向项目以外");
  return file;
}

const revision = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createCodexWorkspace(codex) {
  const processes = new Map();
  const watchers = new Map();
  const emit = (cwd, value) => { for (const send of watchers.get(cwd) || []) send(value); };
  const describe = ({ id, cwd, command, kind, output, running, exitCode, error, startedAt }) => ({ id, cwd, command, kind, output, running, exitCode, error, startedAt });
  const unwatch = codex.watchAgent((message) => {
    if (message.method === "command/exec/outputDelta") {
      const task = processes.get(message.params.processId);
      if (!task) return;
      const output = (task.decoders[message.params.stream] || task.decoders.stdout).write(Buffer.from(message.params.deltaBase64, "base64"));
      task.output = (task.output + output).slice(-1_000_000);
      emit(task.cwd, { type: "output", id: task.id, output });
    } else if (message.method === "connection/closed") {
      for (const task of processes.values()) if (task.running) {
        task.running = false; task.error = "CLI 连接已断开";
        emit(task.cwd, { type: "process", process: describe(task) });
      }
    }
  });

  async function exec(cwd, command) {
    const result = await codex.native("command/exec", { cwd, command, timeoutMs: 20_000, outputBytesCap: 2_000_000 });
    if (result.exitCode !== 0) throw new HttpError(400, result.stderr?.trim() || result.stdout?.trim() || `命令退出：${result.exitCode}`);
    return result.stdout;
  }

  return {
    async tree(cwd, relative) {
      const root = workspaceRoot(cwd);
      const result = await codex.native("fs/readDirectory", { path: inside(root, relative) });
      return { entries: result.entries.filter((entry) => ![".git", "node_modules"].includes(entry.fileName)).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.fileName.localeCompare(b.fileName)) };
    },
    async read(cwd, relative) {
      const root = workspaceRoot(cwd);
      const file = inside(root, relative);
      if (fs.statSync(file).size > 2_000_000) throw new HttpError(400, "编辑器仅打开 2MB 以内的文本文件");
      const bytes = Buffer.from((await codex.native("fs/readFile", { path: file })).dataBase64, "base64");
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new HttpError(400, "请选择 UTF-8 文本文件"); }
      if (text.includes("\0")) throw new HttpError(400, "二进制文件不能在文本编辑器中打开");
      return { path: path.relative(root, file), text, revision: revision(bytes) };
    },
    async write(cwd, relative, text, expected) {
      const root = workspaceRoot(cwd);
      const file = inside(root, relative);
      if (typeof text !== "string" || Buffer.byteLength(text) > 2_000_000) throw new HttpError(400, "文件内容无效或超过 2MB");
      const current = Buffer.from((await codex.native("fs/readFile", { path: file })).dataBase64, "base64");
      if (!expected || revision(current) !== expected) throw new HttpError(409, "文件已被 CLI 或其他程序修改，请重新加载并合并后保存");
      await codex.native("fs/writeFile", { path: file, dataBase64: Buffer.from(text).toString("base64") });
      return { path: path.relative(root, file), text, revision: revision(Buffer.from(text)) };
    },
    async git(cwd, action, body = {}) {
      const root = workspaceRoot(cwd);
      if (action === "status") {
        const status = await exec(root, ["git", "status", "--porcelain=v1", "-z"]);
        const parts = status.split("\0"); const files = [];
        for (let index = 0; index < parts.length; index++) {
          const entry = parts[index]; if (!entry) continue;
          const code = entry.slice(0, 2); const name = entry.slice(3);
          files.push({ status: code, path: name, ...(code.includes("R") || code.includes("C") ? { from: parts[++index] } : {}) });
        }
        const branch = (await exec(root, ["git", "branch", "--show-current"])).trim();
        const branches = (await exec(root, ["git", "branch", "--format=%(refname:short)"])).trim().split("\n").filter(Boolean);
        return { files, branch, branches };
      }
      if (action === "diff") {
        const target = body.path ? [inside(root, body.path) && body.path] : [];
        if (body.untracked && target.length) return { diff: (await this.read(root, body.path)).text, untracked: true };
        return { diff: await exec(root, ["git", "--literal-pathspecs", "diff", "--no-ext-diff", ...(body.staged ? ["--cached"] : []), "--", ...target]) };
      }
      if (["stage", "unstage"].includes(action)) {
        if (!Array.isArray(body.paths) || !body.paths.length || body.paths.length > 200) throw new HttpError(400, "请选择文件");
        for (const file of body.paths) inside(root, file);
        const hasHead = await codex.native("command/exec", { cwd: root, command: ["git", "rev-parse", "--verify", "HEAD"], timeoutMs: 20_000 });
        await exec(root, ["git", "--literal-pathspecs", ...(action === "stage" ? ["add"] : hasHead.exitCode === 0 ? ["reset", "-q", "HEAD"] : ["rm", "--cached", "-q"]), "--", ...body.paths]);
      } else if (action === "branch") {
        if (typeof body.name !== "string" || !body.name.trim() || body.name.startsWith("-")) throw new HttpError(400, "请输入有效分支名称");
        await exec(root, ["git", "switch", "-c", body.name]);
      } else if (action === "commit") {
        if (typeof body.message !== "string" || !body.message.trim()) throw new HttpError(400, "请输入提交说明");
        await exec(root, ["git", "commit", "-m", body.message.trim()]);
      } else throw new HttpError(400, "不支持的 Git 操作");
      return this.git(root, "status");
    },
    async scripts(cwd) {
      const root = workspaceRoot(cwd);
      try { return { scripts: JSON.parse((await this.read(root, "package.json")).text).scripts || {} }; }
      catch (error) { if (error.code === "ENOENT" || /No such file|不存在/.test(error.message)) return { scripts: {} }; throw error; }
    },
    list(cwd) { const root = workspaceRoot(cwd); return { processes: [...processes.values()].filter((task) => task.cwd === root).map(describe) }; },
    async start(cwd, body) {
      const root = workspaceRoot(cwd);
      if ([...processes.values()].filter((entry) => entry.running && entry.cwd === root).length >= 6) throw new HttpError(400, "每个项目最多运行 6 个终端或服务");
      const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
      const terminal = body.kind === "terminal";
      if (!terminal && (typeof body.command !== "string" || !body.command.trim() || body.command.length > 4000)) throw new HttpError(400, "请输入启动命令");
      const command = terminal ? [shell] : process.platform === "win32" ? [shell, "/c", body.command] : [shell, "-lc", body.command];
      const task = { id: randomUUID(), cwd: root, command: terminal ? shell : body.command, kind: terminal ? "terminal" : "service", output: "", running: true, startedAt: Date.now(), decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") } };
      processes.set(task.id, task);
      emit(root, { type: "process", process: describe(task) });
      codex.native("command/exec", { cwd: root, command, processId: task.id, tty: terminal, streamStdoutStderr: true, ...(terminal ? { size: { cols: 100, rows: 28 }, streamStdin: true } : {}), disableTimeout: true, outputBytesCap: 1_000_000 }, 86_400_000)
        .then((result) => { task.exitCode = result.exitCode; if (!task.output) task.output = ((result.stdout || "") + (result.stderr || "")).slice(-1_000_000); })
        .catch((error) => { task.error = error.message; })
        .finally(() => { task.output = (task.output + task.decoders.stdout.end() + task.decoders.stderr.end()).slice(-1_000_000); task.running = false; emit(root, { type: "process", process: describe(task) }); });
      return describe(task);
    },
    async process(cwd, id, action, body = {}) {
      const root = workspaceRoot(cwd); const task = processes.get(id);
      if (!task || task.cwd !== root || !task.running) throw new HttpError(409, "该进程已经结束");
      if (action === "write") {
        if (typeof body.text !== "string" || body.text.length > 100_000 || task.kind !== "terminal") throw new HttpError(400, "终端输入无效");
        return codex.native("command/exec/write", { processId: id, deltaBase64: Buffer.from(body.text).toString("base64") });
      }
      if (action === "resize") {
        if (![body.cols, body.rows].every((size) => Number.isInteger(size) && size > 1 && size < 500)) throw new HttpError(400, "终端尺寸无效");
        return codex.native("command/exec/resize", { processId: id, size: { cols: body.cols, rows: body.rows } });
      }
      if (action === "stop") return codex.native("command/exec/terminate", { processId: id });
      throw new HttpError(400, "不支持的进程操作");
    },
    watch(cwd, send) {
      const root = workspaceRoot(cwd);
      if (!watchers.has(root)) watchers.set(root, new Set());
      watchers.get(root).add(send);
      return () => { watchers.get(root)?.delete(send); if (!watchers.get(root)?.size) watchers.delete(root); };
    },
    close() { unwatch(); watchers.clear(); },
  };
}

export function mountWorkspaceRoutes(app, workspace, route) {
  const base = "/api/codex/workspace";
  app.get(`${base}/tree`, route((req) => workspace.tree(req.query.cwd, req.query.path)));
  app.get(`${base}/file`, route((req) => workspace.read(req.query.cwd, req.query.path)));
  app.put(`${base}/file`, route((req) => workspace.write(req.body.cwd, req.body.path, req.body.text, req.body.revision)));
  app.get(`${base}/git`, route((req) => workspace.git(req.query.cwd, "status")));
  app.post(`${base}/git/:action`, route((req) => workspace.git(req.body.cwd, req.params.action, req.body)));
  app.get(`${base}/scripts`, route((req) => workspace.scripts(req.query.cwd)));
  app.get(`${base}/processes`, route((req) => workspace.list(req.query.cwd)));
  app.post(`${base}/processes`, route((req) => workspace.start(req.body.cwd, req.body)));
  app.post(`${base}/processes/:id/:action`, route((req) => workspace.process(req.body.cwd, req.params.id, req.params.action, req.body)));
  app.get(`${base}/events`, route((req, res) => {
    const initial = workspace.list(req.query.cwd);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "snapshot", ...initial });
    const stop = workspace.watch(req.query.cwd, send);
    const timer = setInterval(() => res.write(": ping\n\n"), 20_000);
    res.on("close", () => { stop(); clearInterval(timer); });
  }));
}
