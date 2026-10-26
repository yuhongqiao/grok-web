import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { foldUpdates, usageOf } from "../client/src/transcript.js";

export { foldUpdates };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SESSION_ID = /^[0-9a-zA-Z-]{16,80}$/;
const TAIL_BYTES = 3_000_000;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "out", "coverage", ".idea", ".vscode", "__pycache__",
  ".venv", "venv", ".next", ".nuxt", ".cache", ".gradle", ".mvn", "vendor", ".DS_Store",
]);

export function defaultPaths(cwd = process.cwd()) {
  const home = os.homedir();
  const grokHome = process.env.GROK_HOME || path.join(home, ".grok");
  return {
    sessionsDir: process.env.GROK_SESSIONS_DIR || path.join(grokHome, "sessions"),
    trashDir: process.env.GROK_TRASH_DIR || path.join(grokHome, "session-trash"),
    projectsFile: process.env.GROK_PROJECTS_FILE || path.join(cwd, "data", "projects.json"),
    parentDir: process.env.GROK_PARENT_DIR || "",
    configFile: process.env.GROK_CONFIG_FILE || path.join(grokHome, "config.toml"),
    activeSessionsFile: process.env.GROK_ACTIVE_SESSIONS_FILE || path.join(grokHome, "active_sessions.json"),
  };
}

// Model list, defaults and permission mode from ~/.grok/config.toml. Keys and URLs stay out.
export function readModelDefaults(text) {
  const models = [];
  let section = "";
  let current = null;
  let effort = null;
  let defaultModel = "";
  let defaultEffort = "";
  let permissionMode = "";
  let legacyYolo = false;
  const finishEffort = () => {
    if (effort && current) current.efforts.push(effort);
    effort = null;
  };
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const effortHeader = line.match(/^\[\[model\."([^"]+)"\.reasoning_efforts\]\]$/);
    const modelHeader = line.match(/^\[model\."([^"]+)"\]$/);
    if (effortHeader || modelHeader || line.startsWith("[")) finishEffort();
    if (effortHeader) {
      current = models.find((item) => item.id === effortHeader[1]);
      if (!current) {
        current = { id: effortHeader[1], efforts: [] };
        models.push(current);
      }
      effort = { id: "", label: "" };
      section = "effort";
      continue;
    }
    if (modelHeader) {
      current = models.find((item) => item.id === modelHeader[1]);
      if (!current) {
        current = { id: modelHeader[1], efforts: [] };
        models.push(current);
      }
      section = "model";
      continue;
    }
    if (line.startsWith("[")) {
      section = line === "[models]" ? "models" : line === "[ui]" ? "ui" : "";
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
    if (!match || match[1] === "api_key" || match[1] === "env_key") continue;
    const value = match[2] ?? match[3];
    if (section === "models" && match[1] === "default") defaultModel = value;
    if (section === "models" && match[1] === "default_reasoning_effort") defaultEffort = value;
    if (section === "ui" && match[1] === "permission_mode") permissionMode = value;
    if (section === "ui" && match[1] === "yolo") legacyYolo = value === "true";
    if (section === "effort" && effort && match[1] === "value") effort.id = value;
    if (section === "effort" && effort && match[1] === "label") effort.label = value;
    if (section === "effort" && effort && match[1] === "default" && value === "true") effort.isDefault = true;
  }
  finishEffort();
  if (!defaultEffort) {
    defaultEffort = models.find((item) => item.id === defaultModel)?.efforts.find((item) => item.isDefault)?.id || "";
  }
  return {
    model: defaultModel,
    effort: defaultEffort,
    permission: permissionOf(permissionMode, legacyYolo),
    models: models.map((item) => ({
      id: item.id,
      efforts: item.efforts.filter((entry) => entry.id).map((entry) => ({ id: entry.id, label: entry.label })),
    })),
  };
}

function permissionOf(mode, legacyYolo) {
  if (["always-approve", "bypassPermissions", "yolo"].includes(mode) || legacyYolo) return "yolo";
  if (mode === "auto") return "auto";
  return "ask";
}

export function lockHeld(lockPath, ignorePids = []) {
  if (!lockPath || !fs.existsSync(lockPath)) return false;
  const other = (pid) => pid > 0 && pid !== process.pid && !ignorePids.includes(pid);
  try {
    const out = execFileSync("lsof", ["-t", "--", lockPath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out.split("\n").some((line) => other(Number(line)));
  } catch (error) {
    // lsof exits 1 when nobody has the file open. Minimal Linux installs may not have it at all.
    if (error.code !== "ENOENT" || process.platform !== "linux") return false;
    return procHolders(lockPath).some(other);
  }
}

// Processes that have the file open, read from /proc.
function procHolders(file) {
  const target = fs.realpathSync(file);
  const pids = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    if (fds.some((fd) => {
      try {
        return fs.readlinkSync(`/proc/${name}/fd/${fd}`) === target;
      } catch {
        return false;
      }
    })) pids.push(Number(name));
  }
  return pids;
}

// Older sessions only have chat_history.jsonl. Folded into the same message shape as updates.
export function foldChatHistory(text) {
  const messages = [];
  const assistant = () => {
    const tail = messages.at(-1);
    if (tail?.role === "assistant") return tail;
    const next = { role: "assistant", blocks: [], meta: null };
    messages.push(next);
    return next;
  };
  const append = (message, type, value) => {
    if (!value) return;
    const last = message.blocks.at(-1);
    if (last?.type === type) last.text += value;
    else message.blocks.push({ type, text: value });
  };
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const value = historyText(row?.content);
    if (row?.type === "user") {
      if (value) messages.push({ role: "user", text: value, images: [], files: [] });
    } else if (row?.type === "assistant") {
      append(assistant(), "text", value);
    } else if (row?.type === "reasoning") {
      append(assistant(), "thinking", value);
    } else if (row?.type === "tool_result" && value) {
      const message = assistant();
      message.blocks.push({
        type: "tool", id: `result-${messages.length}-${message.blocks.length}`, name: "tool_result", kind: "",
        title: "工具结果", status: "completed", input: null, output: value.slice(0, 60_000), diffs: [], paths: [],
      });
    }
  }
  return messages.filter((message) => message.role === "user" || message.blocks.length);
}

function historyText(content) {
  if (content == null) return "";
  if (typeof content === "string") return unwrapQuery(content);
  if (Array.isArray(content)) return unwrapQuery(content.map((block) => historyText(block)).join(""));
  if (typeof content === "object") {
    if (typeof content.text === "string") return unwrapQuery(content.text);
    if (content.content !== undefined) return historyText(content.content);
  }
  return "";
}

function unwrapQuery(text) {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return match ? match[1] : text;
}

export function createStore(options) {
  const sessionsDir = path.resolve(options.sessionsDir);
  const trashDir = path.resolve(options.trashDir);
  const projectsFile = path.resolve(options.projectsFile);
  const fixedParent = options.parentDir ? path.resolve(options.parentDir) : "";
  const configFile = options.configFile ? path.resolve(options.configFile) : "";
  const activeSessionsFile = options.activeSessionsFile ? path.resolve(options.activeSessionsFile) : "";
  const isLockHeld = options.isLockHeld || lockHeld;
  const tempDirs = (options.tempDirs || ["/tmp", "/private/tmp"]).map((dir) => path.resolve(dir));
  const located = new Map();
  let holders = { at: 0, map: new Map() };

  function configDefaults() {
    if (!configFile || !fs.existsSync(configFile)) return { model: "", effort: "", permission: "ask", models: [] };
    try {
      return readModelDefaults(fs.readFileSync(configFile, "utf8"));
    } catch {
      return { model: "", effort: "", permission: "ask", models: [] };
    }
  }

  function registry() {
    try {
      const data = JSON.parse(fs.readFileSync(projectsFile, "utf8"));
      return {
        projects: Array.isArray(data.projects) ? data.projects : [],
        hidden: Array.isArray(data.hidden) ? data.hidden : [],
      };
    } catch {
      return { projects: [], hidden: [] };
    }
  }

  function saveRegistry(data) {
    fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
    const tmp = `${projectsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, projectsFile);
  }

  function decodeProjectKey(encoded) {
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 4000) {
      throw new HttpError(400, "无效的项目");
    }
    if (encoded.includes("\\")) throw new HttpError(400, "无效的项目");
    let decoded = encoded;
    if (!encoded.includes("/")) {
      try {
        decoded = decodeURIComponent(encoded);
      } catch {
        throw new HttpError(400, "无效的项目");
      }
    }
    if (!path.isAbsolute(decoded) || decoded.split("/").includes("..")) throw new HttpError(400, "无效的项目");
    return path.resolve(decoded);
  }

  function sessionDirectory(cwd, id) {
    if (!SESSION_ID.test(String(id))) throw new HttpError(400, "无效的会话");
    const dir = path.resolve(sessionsDir, encodeURIComponent(cwd), id);
    const relative = path.relative(sessionsDir, dir);
    const parts = relative.split(path.sep).filter(Boolean);
    if (relative.startsWith("..") || path.isAbsolute(relative) || parts.length !== 2) {
      throw new HttpError(400, "无效的会话路径");
    }
    return dir;
  }

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  function readSummary(dir, id) {
    const summary = readJson(path.join(dir, "summary.json"));
    if (!summary) return null;
    return {
      id,
      title: summary.generated_title || summary.session_summary || "未命名会话",
      updatedAt: summary.last_active_at || summary.updated_at || summary.created_at || "",
      createdAt: summary.created_at || "",
      model: summary.current_model_id || "",
      effort: summary.reasoning_effort || "",
      messageCount: summary.num_chat_messages || 0,
      parentId: summary.parent_session_id || "",
    };
  }

  function listSessionRecords(cwd) {
    const dir = path.join(sessionsDir, encodeURIComponent(cwd));
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      if (!SESSION_ID.test(name)) continue;
      const sessionDir = path.join(dir, name);
      try {
        if (!fs.statSync(sessionDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const summary = readSummary(sessionDir, name);
      if (summary) records.push(summary);
    }
    records.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return records;
  }

  function projectDirs() {
    let names = [];
    try {
      names = fs.readdirSync(sessionsDir);
    } catch {
      return [];
    }
    const found = [];
    for (const name of names) {
      let cwd;
      try {
        cwd = decodeURIComponent(name);
      } catch {
        continue;
      }
      if (!path.isAbsolute(cwd) || encodeURIComponent(path.resolve(cwd)) !== name) continue;
      try {
        if (!fs.statSync(path.join(sessionsDir, name)).isDirectory()) continue;
      } catch {
        continue;
      }
      found.push(path.resolve(cwd));
    }
    return found;
  }

  // Sessions started in scratch folders are left out of the project list.
  function isTemp(cwd) {
    return tempDirs.some((dir) => cwd === dir || cwd.startsWith(`${dir}${path.sep}`));
  }

  function readTail(file) {
    const size = fs.statSync(file).size;
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString("utf8");
      if (start > 0) {
        const newline = text.indexOf("\n");
        text = newline >= 0 ? text.slice(newline + 1) : "";
      }
      return { text, truncated: start > 0 };
    } finally {
      fs.closeSync(fd);
    }
  }

  function listProjects() {
    const saved = registry();
    const hidden = new Set(saved.hidden.map((cwd) => path.resolve(cwd)));
    const byCwd = new Map();
    for (const project of saved.projects) {
      if (!project?.cwd || !path.isAbsolute(project.cwd)) continue;
      const cwd = path.resolve(project.cwd);
      if (hidden.has(cwd)) continue;
      byCwd.set(cwd, {
        name: project.name || path.basename(cwd),
        cwd,
        encoded: encodeURIComponent(cwd),
        createdAt: project.createdAt || "",
        sessions: listSessionRecords(cwd),
      });
    }
    for (const cwd of projectDirs()) {
      if (hidden.has(cwd) || byCwd.has(cwd) || isTemp(cwd)) continue;
      const sessions = listSessionRecords(cwd);
      if (sessions.length === 0) continue;
      byCwd.set(cwd, { name: path.basename(cwd), cwd, encoded: encodeURIComponent(cwd), createdAt: "", sessions });
    }
    const projects = [...byCwd.values()].sort((a, b) => {
      const aKey = a.sessions[0]?.updatedAt || a.createdAt || "";
      const bKey = b.sessions[0]?.updatedAt || b.createdAt || "";
      return String(bKey).localeCompare(String(aKey));
    });
    return projects;
  }

  // Where new projects go: GROK_PARENT_DIR, else the folder most existing projects sit in, else home.
  function projectParent(projects = listProjects()) {
    if (fixedParent) return fixedParent;
    const counts = new Map();
    for (const project of projects) {
      const parent = path.dirname(project.cwd);
      counts.set(parent, (counts.get(parent) || 0) + 1);
    }
    let best = "";
    for (const [parent, count] of counts) {
      if (!best || count > counts.get(best)) best = parent;
    }
    return best || os.homedir();
  }

  function trashSession(id, cwd, { ignorePids = [] } = {}) {
    const dir = sessionDirectory(cwd, id);
    if (!fs.existsSync(dir)) throw new HttpError(404, "会话不存在");
    if (isLockHeld(path.join(dir, "summary.json.lock"), ignorePids)) {
      throw new HttpError(409, "会话正在别处写入（比如终端里开着），先关掉再删");
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(trashDir, `${stamp}-${id}`);
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(dir, dest);
    located.delete(id);
    return { ok: true, trashedTo: dest };
  }

  return {
    get parentDir() {
      return projectParent();
    },
    sessionsDir,
    configDefaults,
    decodeProjectKey,
    trashSession,

    isDirectory(target) {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },

    locateSession(id) {
      if (!SESSION_ID.test(String(id))) return null;
      const known = located.get(id);
      if (known && fs.existsSync(path.join(sessionsDir, encodeURIComponent(known), id))) return { cwd: known };
      for (const cwd of projectDirs()) {
        if (fs.existsSync(path.join(sessionsDir, encodeURIComponent(cwd), id))) {
          located.set(id, cwd);
          return { cwd };
        }
      }
      return null;
    },

    // Title, model, effort, plan mode and usage for one session. Missing files give blanks.
    sessionInfo(id, cwd) {
      const dir = sessionDirectory(cwd, id);
      const summary = readSummary(dir, id);
      const plan = readJson(path.join(dir, "plan_mode.json"));
      const usage = readJson(path.join(dir, "usage.json"));
      return {
        title: summary?.title || "",
        model: summary?.model || "",
        effort: summary?.effort || "",
        mode: plan?.state === "Active" || plan?.state === "ExitPending" ? "plan" : "default",
        usage: usageOf(usage?.session),
      };
    },

    readSession(id, cwd, { allowMissing = false } = {}) {
      const dir = sessionDirectory(cwd, id);
      const updates = path.join(dir, "updates.jsonl");
      const history = path.join(dir, "chat_history.jsonl");
      if (fs.existsSync(updates)) {
        const tail = readTail(updates);
        return { messages: foldUpdates(tail.text), truncated: tail.truncated };
      }
      if (fs.existsSync(history)) {
        const tail = readTail(history);
        return { messages: foldChatHistory(tail.text), truncated: tail.truncated };
      }
      if (!allowMissing && !fs.existsSync(dir)) throw new HttpError(404, "会话不存在");
      return { messages: [], truncated: false };
    },

    readPlan(id, cwd) {
      const file = path.join(sessionDirectory(cwd, id), "plan.md");
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return "";
      }
    },

    // A Grok terminal that still has this session open, per ~/.grok/active_sessions.json.
    heldElsewhere(id) {
      if (!activeSessionsFile) return 0;
      if (Date.now() - holders.at > 4000) {
        const map = new Map();
        const list = readJson(activeSessionsFile);
        for (const entry of Array.isArray(list) ? list : []) {
          const pid = Number(entry?.pid);
          if (!entry?.session_id || !(pid > 0)) continue;
          try {
            process.kill(pid, 0);
            map.set(entry.session_id, pid);
          } catch {
            // that terminal has exited
          }
        }
        holders = { at: Date.now(), map };
      }
      return holders.map.get(id) || 0;
    },

    searchFiles(encoded, query) {
      const cwd = decodeProjectKey(encoded);
      const needle = String(query || "").toLowerCase().replace(/^\.\//, "");
      const results = [];
      const stack = [""];
      let seen = 0;
      while (stack.length && seen < 25_000) {
        const rel = stack.pop();
        let entries;
        try {
          entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          seen += 1;
          if (SKIP_DIRS.has(entry.name)) continue;
          const child = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".")) stack.push(child);
            continue;
          }
          if (!entry.isFile()) continue;
          const score = matchScore(child.toLowerCase(), entry.name.toLowerCase(), needle);
          if (score > 0) results.push({ path: child, score });
        }
      }
      results.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
      return results.slice(0, 30).map((item) => item.path);
    },

    listState() {
      const projects = listProjects();
      return { parent: projectParent(projects), projects };
    },

    createProject({ name, cwd }) {
      const trimmed = String(name || "").trim();
      if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) {
        throw new HttpError(400, "项目名称无效");
      }
      const target = cwd ? path.resolve(String(cwd)) : path.join(projectParent(), trimmed);
      if (!path.isAbsolute(target) || target === path.parse(target).root) {
        throw new HttpError(400, "项目目录无效");
      }
      if (contained(sessionsDir, target) || contained(trashDir, target)) {
        throw new HttpError(400, "不能把项目建在会话目录里");
      }
      fs.mkdirSync(target, { recursive: true });
      const saved = registry();
      const createdAt = new Date().toISOString();
      const existing = saved.projects.find((project) => path.resolve(project.cwd) === target);
      if (existing) existing.name = trimmed;
      else saved.projects.push({ name: trimmed, cwd: target, createdAt });
      saved.hidden = saved.hidden.filter((item) => path.resolve(item) !== target);
      saveRegistry(saved);
      return {
        name: trimmed,
        cwd: target,
        encoded: encodeURIComponent(target),
        createdAt: existing?.createdAt || createdAt,
        sessions: listSessionRecords(target),
      };
    },

    removeProject(encoded) {
      const cwd = decodeProjectKey(encoded);
      const saved = registry();
      saved.projects = saved.projects.filter((project) => path.resolve(project.cwd) !== cwd);
      if (!saved.hidden.some((item) => path.resolve(item) === cwd)) saved.hidden.push(cwd);
      saveRegistry(saved);
      return { ok: true };
    },
  };
}

function matchScore(rel, base, needle) {
  if (!needle) return 1;
  if (base === needle) return 1000;
  if (base.startsWith(needle)) return 800;
  if (base.includes(needle)) return 600;
  if (rel.includes(needle)) return 400;
  let index = 0;
  for (const char of rel) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return 100;
  }
  return 0;
}

function contained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
