import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "./sessions.js";
import { startCodexAgent } from "./codex-agent.js";
import { codexInput } from "./codex-input.js";
import { interactionResult } from "./codex-interactions.js";
import { applyThreadEvent, runningTurn } from "../client/src/codex/protocol.js";

const REQUESTS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/tool/requestUserInput", "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);

export function createCodexHub({ projectsFile, spawnAgent = startCodexAgent }) {
  let agent = null;
  let catalog = null;
  let modes = null;
  const runtimes = new Map();
  const watchers = new Map();
  const agentWatchers = new Set();
  let browserBridge = null;
  const queueDir = path.join(path.dirname(projectsFile), "codex-queues");

  function emit(id, event) {
    for (const send of watchers.get(id) || []) send(event);
  }

  function runtime(id) {
    if (!runtimes.has(id)) {
      let queue = [];
      try { queue = JSON.parse(fs.readFileSync(queuePath(id), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      queue = queue.map((entry) => ({ ...entry, sending: false, ...(entry.sending ? { error: "服务重启前的发送结果未确认，请先查看历史，再决定继续或移除。" } : {}) }));
      runtimes.set(id, { thread: null, settings: {}, loaded: false, loading: null, starting: false, compacting: false, interactions: new Map(), buffered: [], queue, queuePaused: queue.length > 0 });
    }
    return runtimes.get(id);
  }

  const queuePath = (id) => path.join(queueDir, `${encodeURIComponent(id)}.json`);

  function saveQueue(id) {
    const queue = runtime(id).queue;
    if (!queue.length) { fs.rmSync(queuePath(id), { force: true }); return; }
    fs.mkdirSync(queueDir, { recursive: true });
    const file = queuePath(id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(queue), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  function snapshot(id) {
    const rt = runtime(id);
    return { thread: rt.thread, settings: rt.settings, busy: rt.starting || rt.compacting || Boolean(runningTurn(rt.thread)), interactions: [...rt.interactions.values()], ...queueState(rt) };
  }

  function queueState(rt) {
    return { queue: rt.queue.map(({ id, text, files, skills, error, sending }) => ({ id, text, files, skills, error, sending })), queuePaused: rt.queuePaused };
  }

  function emitQueue(id) { saveQueue(id); emit(id, { type: "queue", ...queueState(runtime(id)) }); }

  function scheduleQueue(id) {
    setTimeout(() => drainQueue(id), 0).unref();
  }

  async function drainQueue(id) {
    const rt = runtimes.get(id);
    if (!rt || rt.queuePaused || snapshot(id).busy || !rt.queue.length || rt.queue[0].sending) return;
    const entry = rt.queue[0];
    entry.sending = true;
    emitQueue(id);
    try {
      await startTurn(id, entry);
      rt.queue = rt.queue.filter((queued) => queued.id !== entry.id);
    } catch (error) {
      rt.queuePaused = true;
      entry.error = error.message;
      emit(id, { type: "error", message: `排队消息发送失败：${error.message}。消息已保留。` });
    } finally { entry.sending = false; emitQueue(id); scheduleQueue(id); }
  }

  function onMessage(message) {
    for (const send of agentWatchers) send(message);
    const p = message.params || {};
    const id = p.threadId;
    if (message.id !== undefined) {
      if (!id || !REQUESTS.has(message.method)) {
        agent.respondError(message.id, `此网页暂不支持 ${message.method}`);
        if (id) emit(id, { type: "error", message: `此网页暂不支持 ${message.method}，请在 Codex CLI 中处理。` });
        return;
      }
      const rt = runtime(id);
      rt.interactions.set(String(message.id), { id: String(message.id), rpcId: message.id, method: message.method, params: p });
      emit(id, { type: "interactions", interactions: [...rt.interactions.values()] });
      return;
    }
    const rt = runtimes.get(id);
    if (!rt) return;
    if (message.method === "serverRequest/resolved") {
      rt.interactions.delete(String(p.requestId));
      emit(id, { type: "interactions", interactions: [...rt.interactions.values()] });
      return;
    }
    if (message.method === "thread/settings/updated") {
      const settings = p.threadSettings;
      applySettings(rt, { ...settings, reasoningEffort: settings.effort, sandbox: settings.sandboxPolicy });
      emit(id, { type: "settings", settings: rt.settings });
      return;
    }
    if (!rt.thread || rt.loading) {
      rt.buffered.push(message);
      return;
    }
    rt.thread = applyThreadEvent(rt.thread, message);
    if (["turn/started", "turn/completed", "thread/compacted"].includes(message.method)) rt.compacting = false;
    if (message.method === "thread/compacted") emit(id, { type: "busy", busy: snapshot(id).busy });
    if (message.method === "error" && rt.compacting && !p.willRetry) {
      rt.compacting = false;
      emit(id, { type: "busy", busy: snapshot(id).busy });
      emit(id, { type: "error", message: p.error?.message || "压缩上下文失败" });
    }
    if (message.method === "turn/completed") {
      if (p.turn.status !== "completed" && rt.queue.length) rt.queuePaused = true;
      for (const [key, request] of rt.interactions) if (request.params.turnId === p.turn.id) rt.interactions.delete(key);
      emit(id, { type: "interactions", interactions: [...rt.interactions.values()] });
      emitQueue(id);
      scheduleQueue(id);
    }
    emit(id, { type: "event", event: message });
  }

  function disconnected(current) {
    if (agent !== current) return;
    agent = null;
    catalog = null;
    modes = null;
    for (const send of agentWatchers) send({ method: "connection/closed", params: {} });
    for (const [id, rt] of runtimes) {
      rt.loaded = false;
      rt.loading = null;
      rt.buffered = [];
      rt.starting = false;
      rt.compacting = false;
      if (rt.queue.length) rt.queuePaused = true;
      rt.interactions.clear();
      if (rt.thread) rt.thread = {
        ...rt.thread, status: { type: "notLoaded" },
        turns: rt.thread.turns.map((turn) => turn.status === "inProgress" ? { ...turn, status: "interrupted" } : turn),
      };
      emit(id, { type: "snapshot", ...snapshot(id) });
      emit(id, { type: "error", message: "Codex 连接已断开，重新打开会话后可继续。" });
    }
  }

  async function ensureAgent() {
    if (!agent?.alive) {
      if (agent) disconnected(agent);
      const next = spawnAgent(browserBridge ? { browserBridge } : {});
      agent = next;
      next.subscribe((message) => { if (agent === next && next.alive) onMessage(message); });
      next.exited.then(() => disconnected(next));
    }
    const current = agent;
    try { await current.ready; } catch (error) {
      throw new HttpError(502, `${error.message}。请确认本机 codex 可运行，或设置 CODEX_AGENT_COMMAND。`);
    }
    return current;
  }

  function projects() {
    try { return JSON.parse(fs.readFileSync(projectsFile, "utf8")); } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  function projectPath(value) {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "请选择项目目录");
    const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
    if (!path.isAbsolute(expanded)) throw new HttpError(400, "请输入项目的完整路径");
    try {
      const cwd = fs.realpathSync(expanded);
      if (fs.statSync(cwd).isDirectory()) return cwd;
    } catch {}
    throw new HttpError(400, "项目目录不存在，请选择已有文件夹");
  }

  function addProject(value) {
    const cwd = projectPath(value);
    const next = [...new Set([cwd, ...projects()])];
    fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
    fs.writeFileSync(projectsFile, JSON.stringify(next, null, 2));
    return { cwd, name: path.basename(cwd) || cwd };
  }

  async function list(cursor, archived = false, query = "") {
    const ag = await ensureAgent();
    if (String(query).trim()) {
      const result = await ag.request("thread/search", { searchTerm: String(query).trim().slice(0, 200), limit: 100, cursor: cursor || null, archived, sortKey: "updated_at", sourceKinds: ["cli", "appServer", "vscode"] });
      return { threads: result.data.map(({ thread, snippet }) => ({ ...thread, snippet })), nextCursor: result.nextCursor || null };
    }
    const result = await ag.request("thread/list", {
      // Some CLI versions label app-server-created threads as vscode.
      limit: 100, cursor: cursor || null, archived, sortKey: "updated_at", modelProviders: [], sourceKinds: ["cli", "appServer", "vscode"],
    });
    return { threads: result.data, nextCursor: result.nextCursor || null };
  }

  function applySettings(rt, result) {
    rt.settings = { model: result.model, effort: result.reasoningEffort || "", approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, activePermissionProfile: result.activePermissionProfile, collaborationMode: result.collaborationMode?.mode || "default" };
  }

  async function open(id) {
    const ag = await ensureAgent();
    const rt = runtime(id);
    if (rt.loaded) return rt;
    if (!rt.loading) {
      const loading = (async () => {
        const result = await ag.request("thread/resume", { threadId: id });
        let thread = result.thread;
        // Newer Codex versions page long histories instead of returning all turns.
        if (result.thread.historyMode === "paginated") {
          let cursor = null;
          const turns = [];
          do {
            const page = await ag.request("thread/turns/list", { threadId: id, cursor, limit: 100, sortDirection: "asc", itemsView: "full" });
            turns.push(...page.data);
            cursor = page.nextCursor;
          } while (cursor);
          thread = { ...thread, turns };
        }
        if (agent !== ag || !ag.alive) throw new HttpError(409, "Codex 连接已改变，请重新打开会话");
        rt.thread = thread;
        applySettings(rt, result);
        rt.loaded = true;
      })().finally(() => { if (rt.loading === loading) rt.loading = null; });
      rt.loading = loading;
    }
    await rt.loading;
    for (const message of rt.buffered.splice(0)) onMessage(message);
    return rt;
  }

  function turnSettings(body) {
    const params = {};
    if (body.model) params.model = String(body.model);
    if (body.effort) params.effort = String(body.effort);
    if (body.mode && body.mode !== "default") {
      if (!["read-only", "workspace-write", "danger-full-access"].includes(body.mode)) throw new HttpError(400, "不支持的权限模式");
      const type = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[body.mode];
      params.sandboxPolicy = { type };
    }
    if (body.permissions !== undefined) {
      if (typeof body.permissions !== "string" || !body.permissions.trim() || params.sandboxPolicy) throw new HttpError(400, "权限配置无效，不能与沙箱模式同时指定");
      params.permissions = body.permissions;
    }
    if (body.approvalPolicy !== undefined && body.approvalPolicy !== "default") {
      const policy = body.approvalPolicy;
      const fields = ["sandbox_approval", "rules", "mcp_elicitations", "request_permissions", "skill_approval"];
      const granular = policy && typeof policy === "object" && !Array.isArray(policy) && Object.keys(policy).length === 1 && policy.granular;
      if (!["untrusted", "on-request", "never"].includes(policy) && !(granular && typeof granular === "object" && !Array.isArray(granular) && fields.slice(0, 3).every((key) => typeof granular[key] === "boolean") && Object.keys(granular).every((key) => fields.includes(key) && typeof granular[key] === "boolean"))) throw new HttpError(400, "不支持的审批策略");
      params.approvalPolicy = policy;
    }
    return params;
  }

  async function collaborationModes() {
    const ag = await ensureAgent();
    if (!modes) modes = ag.request("collaborationMode/list", {}).then((result) => result.data).catch((error) => {
      modes = null;
      if (error.code === -32601) return [];
      throw error;
    });
    return modes;
  }

  async function skills(cwd, forceReload = false) {
    const result = await (await ensureAgent()).request("skills/list", { cwds: [projectPath(cwd)], forceReload });
    return result.data.find((entry) => entry.cwd === projectPath(cwd)) || { cwd, skills: [], errors: [] };
  }

  async function prepare(rt, body) {
    const options = turnSettings(body);
    const input = codexInput(body, rt.thread.cwd);
    if (body.skills !== undefined && (!Array.isArray(body.skills) || body.skills.length > 8 || body.skills.some((entry) => typeof entry !== "string"))) throw new HttpError(400, "技能选择无效");
    if (body.skills?.length) {
      const catalog = await skills(rt.thread.cwd);
      for (const selected of new Set(body.skills)) {
        const skill = catalog.skills.find((entry) => entry.path === selected && entry.enabled);
        if (!skill) throw new HttpError(400, "所选技能已不可用，请重新选择");
        input.push({ type: "skill", name: skill.name, path: skill.path });
      }
    }
    if (body.collaborationMode) {
      const supported = await collaborationModes();
      if (!["plan", "default"].includes(body.collaborationMode) || !supported.some((entry) => entry.mode === body.collaborationMode)) throw new HttpError(400, "此 CLI 不支持所选协作模式");
      options.collaborationMode = { mode: body.collaborationMode, settings: { model: options.model || rt.settings.model, reasoning_effort: options.effort || rt.settings.effort || null, developer_instructions: null } };
    }
    return { id: randomUUID(), text: body.text?.trim() || "", files: (body.attachments || []).map((file) => file.name), skills: input.filter((part) => part.type === "skill").map((part) => part.name), input, options };
  }

  async function startTurn(id, entry) {
    const rt = runtime(id);
    rt.starting = true;
    emit(id, { type: "busy", busy: true });
    try {
      const previousSettings = rt.settings;
      const additionalContext = browserBridge ? { "codex-web-browser": { kind: "application", value: `For this turn the client is Codex Web. Its embedded browser is provided by the native MCP server ${browserBridge.name}. When asked to use a browser to log in or test a website in this client, discover and use that server's browser_open, browser_snapshot, browser_action and browser_screenshot tools; the user automatically sees the page beside this conversation. The desktop cua_repl iab browser is not hosted by this web client. For credentials or verification requiring the user, call browser_handoff, which waits for the user to finish in the embedded browser before returning the updated page. Existing CLI tools, skills, MCP servers and permissions remain available and unchanged. When continued directly in CLI or another client, use that client's available tools instead of this web-only guidance.` } } : undefined;
      const result = await (await ensureAgent()).request("turn/start", { threadId: id, input: entry.input, ...entry.options, ...(additionalContext ? { additionalContext } : {}) });
      onMessage({ method: "turn/started", params: { threadId: id, turn: result.turn } });
      const options = entry.options;
      if (options.model) rt.settings.model = options.model;
      if (options.effort) rt.settings.effort = options.effort;
      if (options.sandboxPolicy && rt.settings === previousSettings) Object.assign(rt.settings, { sandbox: options.sandboxPolicy, activePermissionProfile: null });
      if (options.approvalPolicy !== undefined) rt.settings.approvalPolicy = options.approvalPolicy;
      if (options.collaborationMode) rt.settings.collaborationMode = options.collaborationMode.mode;
      emit(id, { type: "settings", settings: rt.settings });
      return { turnId: result.turn.id };
    } finally {
      rt.starting = false;
      emit(id, { type: "busy", busy: snapshot(id).busy });
      scheduleQueue(id);
    }
  }

  function replaceText(input, text, cwd) {
    if (typeof text !== "string" || text.length > 200_000) throw new HttpError(400, "消息内容无效或超过 200000 字符");
    let removed = false;
    const attachments = input.filter((part) => {
      if (part.type === "mention") return false;
      if (!removed && part.type === "text" && !part.text.startsWith("附件：")) { removed = true; return false; }
      return true;
    });
    if (!text.trim() && !attachments.length) throw new HttpError(400, "请输入消息或保留附件");
    return [...(text.trim() ? codexInput({ text }, cwd) : []), ...attachments];
  }

  return {
    snapshot, open, addProject, list, skills,
    configureBrowser(bridge) { browserBridge = bridge; },
    async native(method, params, timeout) {
      try { return await (await ensureAgent()).request(method, params, timeout); }
      catch (error) {
        if (error.code === -32601) throw new HttpError(501, `当前 CLI 不支持 ${method}，请更新 CLI 后重试`);
        throw error;
      }
    },
    watchAgent(send) { agentWatchers.add(send); return () => agentWatchers.delete(send); },
    async review(id, target) {
      const rt = await open(id);
      if (snapshot(id).busy || rt.queue.length) throw new HttpError(409, "请等待任务结束并处理排队消息后再审查");
      if (!["uncommittedChanges", "baseBranch", "commit", "custom"].includes(target?.type)) throw new HttpError(400, "请选择审查范围");
      const field = { baseBranch: "branch", commit: "sha", custom: "instructions" }[target.type];
      if (field && (typeof target[field] !== "string" || !target[field].trim())) throw new HttpError(400, "请填写审查目标");
      rt.starting = true;
      emit(id, { type: "busy", busy: true });
      try {
        const result = await (await ensureAgent()).request("review/start", { threadId: id, target, delivery: "inline" });
        onMessage({ method: "turn/started", params: { threadId: id, turn: result.turn } });
        return result;
      } finally { rt.starting = false; emit(id, { type: "busy", busy: snapshot(id).busy }); }
    },
    async skillConfig(cwd, selected, enabled) {
      if (typeof enabled !== "boolean") throw new HttpError(400, "技能状态无效");
      const catalog = await skills(cwd, true);
      if (!catalog.skills.some((skill) => skill.path === selected)) throw new HttpError(400, "找不到此技能，请刷新列表");
      await (await ensureAgent()).request("skills/config/write", { path: selected, enabled });
      return skills(cwd, true);
    },
    async files(cwd, query) {
      return (await ensureAgent()).request("fuzzyFileSearch", { roots: [projectPath(cwd)], query: String(query || "").slice(0, 200) });
    },
    async image(id, itemId, index) {
      const rt = await open(id);
      const item = rt.thread.turns.flatMap((turn) => turn.items).find((item) => item.id === itemId && item.type === "userMessage");
      const part = item?.content?.[Number(index)];
      if (part?.type !== "localImage") throw new HttpError(404, "找不到此图片");
      const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(part.path).toLowerCase()];
      if (!mime) throw new HttpError(400, "图片格式暂不支持");
      const file = path.resolve(rt.thread.cwd, part.path);
      try {
        if (fs.statSync(file).size > 20 * 1024 * 1024) throw new HttpError(400, "图片超过 20MB");
        return { bytes: await fs.promises.readFile(file), mime };
      } catch (error) { if (error.code === "ENOENT") throw new HttpError(404, "本地图片已不存在"); throw error; }
    },
    async state() {
      const ag = await ensureAgent();
      if (!catalog) catalog = ag.request("model/list", { limit: 100 }).catch((error) => { catalog = null; throw error; });
      const [models, account, page, collaboration] = await Promise.all([catalog, ag.request("account/read", { refreshToken: false }), list(), collaborationModes()]);
      const paths = new Set([...projects(), ...page.threads.map((thread) => thread.cwd).filter(Boolean)]);
      return {
        ...page, models: models.data.filter((model) => !model.hidden),
        collaborationModes: collaboration.filter((entry) => ["plan", "default"].includes(entry.mode)),
        account: { authenticated: Boolean(account.account), type: account.account?.type || null },
        projects: [...paths].map((cwd) => ({ cwd, name: path.basename(cwd) || cwd })),
        parent: process.env.CODEX_PARENT_DIR || os.homedir(),
        live: Object.fromEntries([...runtimes].map(([id, rt]) => [id, { busy: snapshot(id).busy, waiting: rt.interactions.size > 0, lastCompletedTurnId: rt.thread?.turns.findLast((turn) => turn.status !== "inProgress")?.id || null }])),
      };
    },
    async permissions(cwd) {
      const ag = await ensureAgent();
      const data = [];
      let cursor = null;
      try {
        do {
          const page = await ag.request("permissionProfile/list", { cwd: projectPath(cwd), cursor });
          data.push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
        return { profiles: data, supported: true };
      } catch (error) {
        if (error.code === -32601) return { profiles: [], supported: false };
        throw error;
      }
    },
    async create(body) {
      const cwd = projectPath(body.cwd);
      const options = turnSettings(body);
      const ag = await ensureAgent();
      const result = await ag.request("thread/start", {
        cwd, historyMode: "paginated", ...(options.model ? { model: options.model } : {}),
        ...(options.sandboxPolicy ? { sandbox: body.mode } : {}),
        ...(options.permissions ? { permissions: options.permissions } : {}),
        ...(options.approvalPolicy !== undefined ? { approvalPolicy: options.approvalPolicy } : {}),
      });
      const rt = runtime(result.thread.id);
      rt.thread = result.thread;
      rt.loaded = true;
      applySettings(rt, result);
      addProject(cwd);
      return snapshot(result.thread.id);
    },
    async prompt(id, body) {
      const rt = await open(id);
      if (body.delivery && !["queue", "steer"].includes(body.delivery)) throw new HttpError(400, "不支持的发送方式");
      const entry = await prepare(rt, body);
      if (body.delivery === "steer") {
        const turn = runningTurn(rt.thread);
        if (!turn || turn.id !== body.expectedTurnId) throw new HttpError(409, "当前任务已改变，补充消息未发送，请重新确认");
        return (await ensureAgent()).request("turn/steer", { threadId: id, expectedTurnId: turn.id, input: entry.input });
      }
      if (snapshot(id).busy || rt.queue.length) {
        if (body.delivery !== "queue") throw new HttpError(409, "Codex 正在运行，请使用排队或立即补充");
        if (rt.queue.length >= 5) throw new HttpError(400, "最多排队 5 条消息");
        rt.queue.push(entry);
        emitQueue(id);
        scheduleQueue(id);
        return { queued: true, entryId: entry.id };
      }
      rt.queuePaused = false;
      return startTurn(id, entry);
    },
    async queueAction(id, entryId, action, expectedTurnId, text) {
      const rt = await open(id);
      if (action === "resume" || action === "pause") {
        rt.queuePaused = action === "pause";
        emitQueue(id);
        scheduleQueue(id);
        return { ok: true };
      }
      const index = rt.queue.findIndex((entry) => entry.id === entryId);
      if (index < 0) throw new HttpError(409, "这条消息已经发送或移除");
      const entry = rt.queue[index];
      if (entry.sending) throw new HttpError(409, "这条消息正在发送");
      if (action === "edit") {
        entry.input = replaceText(entry.input, text, rt.thread.cwd);
        entry.text = text.trim();
        delete entry.error;
      } else if (action === "up" || action === "down") {
        const next = index + (action === "up" ? -1 : 1);
        if (next < 0 || next >= rt.queue.length || rt.queue[next].sending) throw new HttpError(409, "无法移动到此位置");
        [rt.queue[index], rt.queue[next]] = [rt.queue[next], entry];
      } else if (action === "steer") {
        const turn = runningTurn(rt.thread);
        if (!turn || turn.id !== expectedTurnId) throw new HttpError(409, "当前任务已改变，消息仍保留在队列中");
        entry.sending = true;
        emitQueue(id);
        try {
          await (await ensureAgent()).request("turn/steer", { threadId: id, expectedTurnId: turn.id, input: entry.input });
          rt.queue = rt.queue.filter((queued) => queued.id !== entryId);
        } finally { entry.sending = false; emitQueue(id); scheduleQueue(id); }
      } else if (action !== "remove") throw new HttpError(400, "不支持的队列操作");
      if (action === "remove") rt.queue = rt.queue.filter((entry) => entry.id !== entryId);
      emitQueue(id);
      return { ok: true };
    },
    async cancel(id) {
      const rt = await open(id);
      const turn = runningTurn(rt.thread);
      if (!turn) throw new HttpError(409, "当前没有可以停止的任务");
      rt.queuePaused = true;
      emitQueue(id);
      return (await ensureAgent()).request("turn/interrupt", { threadId: id, turnId: turn.id });
    },
    async answer(id, requestId, body) {
      const rt = runtime(id);
      const request = rt.interactions.get(requestId);
      if (!request) throw new HttpError(409, "此请求已经结束，请刷新会话");
      const result = interactionResult(request, body);
      if (!agent?.alive) throw new HttpError(409, "此请求的 Codex 连接已结束，请重新打开会话");
      agent.respond(request.rpcId, result);
      rt.interactions.delete(requestId);
      emit(id, { type: "interactions", interactions: [...rt.interactions.values()] });
      return { ok: true };
    },
    async rename(id, name) {
      if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "名称不能为空");
      const ag = await ensureAgent();
      await ag.request("thread/name/set", { threadId: id, name: name.trim() });
      onMessage({ method: "thread/name/updated", params: { threadId: id, threadName: name.trim() } });
      return { ok: true };
    },
    async archive(id) {
      if (snapshot(id).busy || runtime(id).queue.length) throw new HttpError(409, "请先停止任务并移除排队消息再归档");
      await (await ensureAgent()).request("thread/archive", { threadId: id });
      runtimes.delete(id);
      emit(id, { type: "archived" });
      return { ok: true };
    },
    async unarchive(id) {
      await (await ensureAgent()).request("thread/unarchive", { threadId: id });
      runtime(id).loaded = false;
      await open(id);
      return { ok: true };
    },
    async fork(id, lastTurnId) {
      const rt = await open(id);
      if (snapshot(id).busy) throw new HttpError(409, "请等待任务结束后再分叉");
      if (lastTurnId && !rt.thread.turns.some((turn) => turn.id === lastTurnId)) throw new HttpError(400, "找不到要分叉的轮次");
      const result = await (await ensureAgent()).request("thread/fork", { threadId: id, ...(lastTurnId ? { lastTurnId } : {}), excludeTurns: true });
      await open(result.thread.id);
      return snapshot(result.thread.id);
    },
    async revise(id, turnId, body) {
      const rt = await open(id);
      if (snapshot(id).busy || rt.queue.length) throw new HttpError(409, "请先等待任务结束并处理排队消息");
      const turn = rt.thread.turns.find((turn) => turn.id === turnId);
      if (!turn) throw new HttpError(400, "找不到此轮对话");
      if (!["revert", "retry", "edit"].includes(body.action)) throw new HttpError(400, "不支持的历史操作");
      const original = turn.items.find((item) => item.type === "userMessage")?.content;
      if (body.action !== "revert" && !original?.length) throw new HttpError(400, "此轮没有可重试的用户输入");
      const input = body.action === "edit" ? replaceText(original, body.text, rt.thread.cwd) : original;
      if (body.action === "revert" && rt.thread.historyMode !== "paginated") throw new HttpError(400, "旧版历史不支持原地回退，请使用编辑或重试创建分支");
      rt.starting = true;
      emit(id, { type: "busy", busy: true });
      try {
        const ag = await ensureAgent();
        if (body.action === "revert") {
          await ag.request("thread/revert", { threadId: id, beforeTurnId: turnId });
          rt.loaded = false;
          await open(id);
          rt.starting = false;
          return snapshot(id);
        }
        const result = await ag.request("thread/fork", { threadId: id, beforeTurnId: turnId, excludeTurns: true });
        await open(result.thread.id);
        try { await startTurn(result.thread.id, { input, options: turnSettings(body) }); }
        catch (error) {
          const forked = runtime(result.thread.id);
          forked.queue.push({ id: randomUUID(), text: input.find((part) => part.type === "text" && !part.text.startsWith("附件："))?.text || "", files: [], skills: input.filter((part) => part.type === "skill").map((part) => part.name), input, options: turnSettings(body), error: error.message });
          forked.queuePaused = true;
          emitQueue(result.thread.id);
          return { ...snapshot(result.thread.id), sendError: error.message };
        }
        return snapshot(result.thread.id);
      } finally { rt.starting = false; emit(id, { type: "snapshot", ...snapshot(id) }); scheduleQueue(id); }
    },
    async settings(id, body) {
      const rt = await open(id);
      if (snapshot(id).busy) throw new HttpError(409, "请等待当前任务结束后修改会话设置");
      const { options } = await prepare(rt, { ...body, text: "settings" });
      const previousSettings = rt.settings;
      await (await ensureAgent()).request("thread/settings/update", { threadId: id, ...options });
      if (options.model) rt.settings.model = options.model;
      if (options.effort) rt.settings.effort = options.effort;
      if (options.sandboxPolicy && rt.settings === previousSettings) Object.assign(rt.settings, { sandbox: options.sandboxPolicy, activePermissionProfile: null });
      if (options.approvalPolicy !== undefined) rt.settings.approvalPolicy = options.approvalPolicy;
      if (options.collaborationMode) rt.settings.collaborationMode = options.collaborationMode.mode;
      emit(id, { type: "settings", settings: rt.settings });
      return rt.settings;
    },
    async compact(id) {
      const rt = await open(id);
      if (snapshot(id).busy || rt.queue.length) throw new HttpError(409, "请等待任务和排队消息结束后再压缩上下文");
      rt.compacting = true;
      emit(id, { type: "busy", busy: true });
      try { return await (await ensureAgent()).request("thread/compact/start", { threadId: id }); } catch (error) {
        rt.compacting = false;
        emit(id, { type: "busy", busy: snapshot(id).busy });
        throw error;
      }
    },
    watch(id, send) {
      if (!watchers.has(id)) watchers.set(id, new Set());
      watchers.get(id).add(send);
      return () => { watchers.get(id)?.delete(send); if (!watchers.get(id)?.size) watchers.delete(id); };
    },
    stop() { agent?.stop(); },
  };
}

export function mountCodexRoutes(app, hub, route) {
  app.get("/api/codex/state", route(() => hub.state()));
  app.get("/api/codex/permissions", route((req) => hub.permissions(req.query.cwd)));
  app.get("/api/codex/threads", route((req) => hub.list(req.query.cursor, req.query.archived === "true", req.query.q)));
  app.get("/api/codex/skills", route((req) => hub.skills(req.query.cwd, req.query.refresh === "true")));
  app.patch("/api/codex/skills", route((req) => hub.skillConfig(req.body?.cwd, req.body?.path, req.body?.enabled)));
  app.get("/api/codex/files", route((req) => hub.files(req.query.cwd, req.query.q)));
  app.post("/api/codex/projects", route((req) => hub.addProject(req.body?.cwd), 201));
  app.post("/api/codex/threads", route((req) => hub.create(req.body || {}), 201));
  app.get("/api/codex/threads/:id/images/:itemId/:index", route(async (req, res) => {
    const image = await hub.image(req.params.id, req.params.itemId, req.params.index);
    res.set({ "content-type": image.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff" }).send(image.bytes);
  }));
  app.get("/api/codex/threads/:id/events", route(async (req, res) => {
    await hub.open(req.params.id);
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "snapshot", ...hub.snapshot(req.params.id) });
    const unwatch = hub.watch(req.params.id, send);
    const timer = setInterval(() => res.write(": ping\n\n"), 20_000);
    res.on("close", () => { clearInterval(timer); unwatch(); });
  }));
  app.post("/api/codex/threads/:id/prompt", route((req) => hub.prompt(req.params.id, req.body || {})));
  app.post("/api/codex/threads/:id/cancel", route((req) => hub.cancel(req.params.id)));
  app.post("/api/codex/threads/:id/queue/:entryId", route((req) => hub.queueAction(req.params.id, req.params.entryId, req.body?.action, req.body?.expectedTurnId, req.body?.text)));
  app.post("/api/codex/threads/:id/fork", route((req) => hub.fork(req.params.id, req.body?.lastTurnId), 201));
  app.post("/api/codex/threads/:id/turns/:turnId/revise", route((req) => hub.revise(req.params.id, req.params.turnId, req.body || {})));
  app.patch("/api/codex/threads/:id/settings", route((req) => hub.settings(req.params.id, req.body || {})));
  app.post("/api/codex/threads/:id/compact", route((req) => hub.compact(req.params.id)));
  app.post("/api/codex/threads/:id/review", route((req) => hub.review(req.params.id, req.body?.target)));
  app.post("/api/codex/threads/:id/restore", route((req) => hub.unarchive(req.params.id)));
  app.post("/api/codex/threads/:id/interactions/:requestId", route((req) => hub.answer(req.params.id, req.params.requestId, req.body || {})));
  app.patch("/api/codex/threads/:id", route((req) => hub.rename(req.params.id, req.body?.name)));
  app.delete("/api/codex/threads/:id", route((req) => hub.archive(req.params.id)));
}
