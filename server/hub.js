import { applyUpdate, usageOf } from "../client/src/transcript.js";
import { buildPrompt, mentions } from "./prompt.js";
import { HttpError } from "./sessions.js";

// Everything the transcript shows. Other session updates only change the session state.
const TRANSCRIPT = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan", "turn_completed", "rewind_marker"]);
const PERMISSIONS = new Set(["ask", "auto", "yolo"]);

// One `grok agent stdio` process for every session opened from the browser. Each session keeps
// its live state here (running turn, Grok's own queue, approvals it waits for) and fans events
// out to the browser tabs watching it.
export function createHub({ store, spawnAgent }) {
  let agent = null;
  let starting = null;
  let lastCommands = null;
  const runtimes = new Map();
  const watchers = new Map();

  function emit(id, event) {
    for (const send of watchers.get(id) || []) {
      try {
        send(event);
      } catch {
        // a closed tab; its stream cleans up on its own
      }
    }
  }

  function runtime(id, cwd) {
    let rt = runtimes.get(id);
    if (rt) return rt;
    rt = {
      id, cwd, loaded: false, loading: null, replaying: false,
      permission: store.configDefaults().permission, mode: "default", model: "", effort: "", efforts: null, title: "",
      running: null, queue: [], turn: null, pending: new Map(), retry: null, tasks: [], commands: null,
      usage: null, lastTurn: null, sent: [], sendNow: [],
    };
    refreshFromDisk(rt);
    runtimes.set(id, rt);
    return rt;
  }

  function refreshFromDisk(rt) {
    try {
      const info = store.sessionInfo(rt.id, rt.cwd);
      rt.title = info.title || rt.title;
      rt.model = info.model || rt.model;
      rt.effort = info.effort || rt.effort;
      rt.mode = info.mode;
      rt.usage = info.usage || rt.usage;
    } catch {
      // a session Grok has not written yet
    }
  }

  function locate(id) {
    const known = runtimes.get(id);
    if (known) return known;
    const found = store.locateSession(id);
    if (!found) throw new HttpError(404, "会话不存在");
    return runtime(id, found.cwd);
  }

  async function ensureAgent() {
    if (agent?.alive) {
      try {
        await agent.ready;
        return agent;
      } catch (error) {
        throw new HttpError(502, `Grok 没有启动：${error.message}`);
      }
    }
    if (!starting) {
      starting = (async () => {
        const next = spawnAgent();
        agent = next;
        next.subscribe(onMessage);
        next.exited.then(() => onExit(next));
        try {
          await next.ready;
          loadCommands(next);
          return next;
        } catch (error) {
          if (agent === next) agent = null;
          throw new HttpError(502, `Grok 没有启动：${error.message}`);
        } finally {
          starting = null;
        }
      })();
    }
    return starting;
  }

  function onExit(dead) {
    if (agent !== dead) return;
    agent = null;
    const reason = dead.stderrTail?.() || "";
    for (const rt of runtimes.values()) {
      const busy = rt.running || rt.queue.length || rt.pending.size;
      rt.loaded = false;
      rt.running = null;
      rt.queue = [];
      rt.pending.clear();
      rt.retry = null;
      rt.sendNow = [];
      pushState(rt);
      if (busy) emit(rt.id, { type: "error", message: `Grok 进程退出了${reason ? `：${reason}` : ""}。再发一条会自动重启。` });
    }
  }

  function loadCommands(ag) {
    const base = ag.info?._meta?.availableCommands || [];
    ag.request("_x.ai/skills/list", { cwd: store.parentDir }, 20_000).then((result) => {
      const skills = (result?.result?.skills || [])
        .filter((skill) => skill.user_invocable !== false && skill.enabled !== false)
        .map((skill) => ({
          name: skill.name,
          description: skill.short_description || skill.description || "",
          input: skill.argument_hint ? { hint: skill.argument_hint } : null,
          _meta: { scope: skill.scope || "skill" },
        }));
      if (!lastCommands) lastCommands = commandsOf([...base, ...skills]);
    }, () => {
      if (!lastCommands) lastCommands = commandsOf(base);
    });
  }

  function onMessage(message) {
    const params = message.params || {};
    if (message.id !== undefined) {
      onRequest(message);
      return;
    }
    switch (message.method) {
      case "session/update":
      case "_x.ai/session/update":
      case "_x.ai/session_notification":
        onUpdate(params.sessionId, params.update, params._meta);
        return;
      case "_x.ai/queue/changed":
        onQueue(params);
        return;
      case "_x.ai/sessions/changed":
        for (const entry of params.upserted || []) {
          const rt = runtimes.get(entry.sessionId);
          if (rt && entry.title && entry.title !== rt.title) {
            rt.title = String(entry.title);
            pushState(rt, true);
          }
        }
        return;
      default:
    }
  }

  function onUpdate(id, update, meta) {
    const rt = runtimes.get(id);
    if (!rt || !update) return;
    const kind = update.sessionUpdate;
    if (TRANSCRIPT.has(kind)) {
      if (rt.replaying) return;
      const extra = { timestamp: meta?.agentTimestampMs || Date.now() };
      if (rt.turn) rt.turn.messages = applyUpdate(rt.turn.messages, update, extra);
      emit(id, { type: "update", update, meta: extra });
      if (kind === "turn_completed") {
        onTurnDone(rt, update);
      } else if (rt.retry && kind !== "rewind_marker") {
        rt.retry = null;
        pushState(rt);
      }
      return;
    }
    switch (kind) {
      case "current_mode_update":
        if (rt.replaying) return;
        rt.mode = update.currentModeId === "plan" ? "plan" : "default";
        pushState(rt);
        return;
      case "config_option_update":
        readConfig(rt, update.configOptions);
        pushState(rt);
        return;
      case "model_changed":
        if (update.model_id) rt.model = String(update.model_id);
        if (update.reasoning_effort) rt.effort = String(update.reasoning_effort);
        pushState(rt);
        return;
      case "session_info_update":
        if (update.title && update.title !== rt.title) {
          rt.title = String(update.title);
          pushState(rt, true);
        }
        return;
      case "available_commands_update":
        rt.commands = commandsOf(update.availableCommands);
        lastCommands = rt.commands;
        pushState(rt);
        return;
      case "retry_state":
        rt.retry = retryOf(update);
        pushState(rt);
        return;
      case "background_tasks":
        rt.tasks = (update.tasks || []).map((task) => ({
          id: String(task.task_id || ""),
          command: String(task.command || task.description || ""),
          status: String(task.status || ""),
        }));
        pushState(rt);
        return;
      case "interaction_resolved":
        for (const [requestId, item] of rt.pending) {
          if (item.interaction.toolCallId && item.interaction.toolCallId === update.tool_call_id) {
            rt.pending.delete(requestId);
            emit(id, { type: "interaction_resolved", requestId });
            pushState(rt, true);
          }
        }
        return;
      default:
    }
  }

  function onTurnDone(rt, update) {
    rt.lastTurn = { stopReason: String(update.stop_reason || ""), elapsedMs: Number(update.elapsed_ms) || 0, usage: usageOf(update.usage) };
    rt.retry = null;
    for (const requestId of rt.pending.keys()) emit(rt.id, { type: "interaction_resolved", requestId });
    rt.pending.clear();
    pushState(rt, true);
    agent?.request("_x.ai/session/usage", { sessionId: rt.id }, 10_000).then((result) => {
      const usage = usageOf(result?.usage);
      if (usage) {
        rt.usage = usage;
        pushState(rt);
      }
    }, () => {});
  }

  // Grok runs one prompt per session at a time and queues the rest; this mirrors that queue.
  function onQueue(params) {
    const rt = runtimes.get(params.sessionId);
    if (!rt) return;
    rt.queue = (params.entries || []).map((entry) => ({ id: String(entry.id), text: String(entry.text || ""), kind: entry.kind || "prompt" }));
    const runningId = params.runningPromptId ? String(params.runningPromptId) : "";
    if (runningId && runningId !== rt.running?.promptId) startTurn(rt, runningId, String(params.runningText || ""), params.runningKind);
    else if (!runningId) rt.running = null;
    for (const entry of rt.queue) {
      const at = rt.sendNow.indexOf(entry.text.trim());
      if (at < 0) continue;
      rt.sendNow.splice(at, 1);
      agent?.notify("_x.ai/queue/interject", { sessionId: rt.id, id: entry.id });
    }
    pushState(rt, true);
  }

  function startTurn(rt, promptId, text, kind) {
    const sent = takeSent(rt, text);
    const message = kind && kind !== "prompt"
      ? null
      : { role: "user", text: sent?.text ?? text, images: sent?.images || [], files: sent?.files || [] };
    rt.running = { promptId, startedAt: Date.now() };
    rt.turn = { promptId, messages: message ? [message] : [] };
    rt.retry = null;
    emit(rt.id, { type: "turn_start", promptId, message });
  }

  function takeSent(rt, text) {
    const clean = text.trim();
    const at = rt.sent.findIndex((item) => item.text === clean || (item.text && clean.startsWith(item.text)));
    return at >= 0 ? rt.sent.splice(at, 1)[0] : null;
  }

  function onRequest(message) {
    const params = message.params || {};
    const rt = runtimes.get(params.sessionId);
    const requestId = String(message.id);
    let interaction = null;
    if (message.method === "session/request_permission") {
      const call = params.toolCall || {};
      interaction = {
        kind: "permission",
        requestId,
        toolCallId: String(call.toolCallId || ""),
        title: String(call.title || "需要批准一个操作"),
        tool: String(call._meta?.["x.ai/tool"]?.name || ""),
        toolKind: String(call._meta?.["x.ai/tool"]?.kind || call.kind || ""),
        input: call.rawInput ?? null,
        options: (params.options || []).map((option) => ({
          optionId: String(option.optionId),
          name: String(option.name || option.optionId),
          kind: String(option.kind || ""),
        })),
      };
    } else if (message.method === "_x.ai/ask_user_question") {
      interaction = {
        kind: "question",
        requestId,
        toolCallId: String(params.toolCallId || ""),
        questions: (params.questions || []).map((question) => ({
          question: String(question.question || ""),
          multiSelect: Boolean(question.multiSelect ?? question.multi_select),
          options: (question.options || []).map((option) => ({ label: String(option.label || ""), description: String(option.description || "") })),
        })),
      };
    } else if (message.method === "_x.ai/exit_plan_mode") {
      interaction = { kind: "plan", requestId, toolCallId: String(params.toolCallId || ""), plan: String(params.planContent || "") };
    }
    if (!interaction || !rt) {
      if (message.method === "session/request_permission") agent?.respond(message.id, { outcome: { outcome: "cancelled" } });
      else agent?.respondError(message.id, -32601, `grok-web 不处理 ${message.method}`);
      return;
    }
    rt.pending.set(requestId, { rpcId: message.id, interaction });
    emit(rt.id, { type: "interaction", interaction });
    pushState(rt, true);
  }

  function readConfig(rt, options) {
    for (const option of Array.isArray(options) ? options : []) {
      if (option.id === "model" && option.currentValue) rt.model = String(option.currentValue);
      if (option.id === "reasoning_effort") {
        if (option.currentValue) rt.effort = String(option.currentValue);
        rt.efforts = (option.options || []).map((item) => ({ id: String(item.value), label: String(item.name || item.value) }));
      }
    }
  }

  function publicState(rt) {
    return {
      sessionId: rt.id,
      cwd: rt.cwd,
      loaded: rt.loaded,
      running: Boolean(rt.running),
      runningSince: rt.running?.startedAt || null,
      queue: rt.queue,
      interactions: [...rt.pending.values()].map((item) => item.interaction),
      mode: rt.mode,
      permission: rt.permission,
      model: rt.model,
      effort: rt.effort,
      efforts: rt.efforts,
      title: rt.title,
      retry: rt.retry,
      tasks: rt.tasks,
      commands: rt.commands || lastCommands || [],
      usage: rt.usage,
      lastTurn: rt.lastTurn,
      elsewhere: store.heldElsewhere(rt.id),
    };
  }

  function pushState(rt, list = false) {
    emit(rt.id, { type: "state", state: publicState(rt), list });
  }

  async function load(id) {
    const rt = locate(id);
    if (rt.loaded && agent?.alive) return rt;
    if (!rt.loading) {
      rt.loading = (async () => {
        const ag = await ensureAgent();
        rt.replaying = true;
        try {
          const result = await ag.request("session/load", {
            sessionId: id, cwd: rt.cwd, mcpServers: [], _meta: permissionMeta(rt.permission),
          }, 120_000);
          readConfig(rt, result?.configOptions);
          rt.loaded = true;
        } finally {
          rt.replaying = false;
        }
        pushState(rt);
      })().finally(() => {
        rt.loading = null;
      });
    }
    await rt.loading;
    return rt;
  }

  async function setOption(rt, configId, value) {
    const result = await agent.request("session/set_config_option", { sessionId: rt.id, configId, value: String(value) }, 30_000);
    readConfig(rt, result?.configOptions);
  }

  function requireIdle(rt, message) {
    if (rt.running || rt.queue.length || rt.pending.size) throw new HttpError(409, message);
  }

  async function prompt(id, body) {
    const rt = await load(id);
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const blocks = buildPrompt(body.text, attachments, { cwd: rt.cwd });
    const text = String(body.text || "").trim();
    rt.sent.push({
      text,
      images: attachments.filter((file) => String(file?.mimeType).startsWith("image/") && String(file.data || "").length < 3_000_000)
        .map((file) => ({ mimeType: file.mimeType, data: file.data })),
      files: [
        ...attachments.filter((file) => !String(file?.mimeType).startsWith("image/")).map((file) => String(file.name || "附件")),
        ...mentions(text, rt.cwd).map((file) => file.split("/").pop()),
      ],
    });
    if (rt.sent.length > 20) rt.sent.shift();
    if (body.now && (rt.running || rt.queue.length)) rt.sendNow.push(text);
    const ag = agent;
    ag.request("session/prompt", { sessionId: id, prompt: blocks }, 0).catch((error) => {
      if (agent === ag) emit(id, { type: "error", message: error.message || "发送失败" });
    });
    return { ok: true };
  }

  return {
    start() {
      ensureAgent().catch((error) => console.error(error.message));
    },

    stop() {
      agent?.stop();
    },

    get agentPid() {
      return agent?.pid || 0;
    },

    defaults() {
      const config = store.configDefaults();
      const state = agent?.info?._meta?.modelState;
      const models = state?.availableModels?.length
        ? state.availableModels.map((model) => ({
          id: String(model.modelId),
          name: String(model.name || model.modelId),
          effort: String(model._meta?.reasoningEffort || ""),
          efforts: (model._meta?.reasoningEfforts || []).map((item) => ({ id: String(item.value || item.id), label: String(item.label || item.value) })),
        }))
        : config.models.map((model) => ({ id: model.id, name: model.id, effort: "", efforts: model.efforts }));
      const model = state?.currentModelId || config.model || models[0]?.id || "";
      return {
        model,
        effort: models.find((item) => item.id === model)?.effort || config.effort || "",
        models,
        permission: config.permission,
        commands: lastCommands || [],
      };
    },

    live() {
      const result = {};
      for (const rt of runtimes.values()) {
        if (rt.running || rt.queue.length || rt.pending.size) {
          result[rt.id] = { running: Boolean(rt.running), queued: rt.queue.length, waiting: rt.pending.size > 0 };
        }
      }
      return result;
    },

    watch(id, send) {
      if (!watchers.has(id)) watchers.set(id, new Set());
      watchers.get(id).add(send);
      return () => {
        const set = watchers.get(id);
        set?.delete(send);
        if (set && !set.size) watchers.delete(id);
      };
    },

    // History from disk plus the turn that is still streaming. Synchronous on purpose: the
    // caller subscribes in the same tick, so no event falls between the two.
    snapshot(id) {
      const rt = locate(id);
      if (!rt.loaded) refreshFromDisk(rt);
      const disk = store.readSession(id, rt.cwd, { allowMissing: true });
      const messages = rt.turn ? mergeTurn(disk.messages, rt.turn.messages) : disk.messages;
      return { messages, truncated: disk.truncated, state: publicState(rt) };
    },

    async create(encoded, body) {
      const cwd = store.decodeProjectKey(encoded);
      if (!store.isDirectory(cwd)) throw new HttpError(400, "项目目录不存在");
      buildPrompt(body.text, Array.isArray(body.attachments) ? body.attachments : [], { cwd });
      const permission = PERMISSIONS.has(body.permission) ? body.permission : store.configDefaults().permission;
      const ag = await ensureAgent();
      const created = await ag.request("session/new", { cwd, mcpServers: [], _meta: permissionMeta(permission) }, 120_000);
      const id = created?.sessionId ? String(created.sessionId) : "";
      if (!id) throw new HttpError(502, "Grok 没有返回会话编号");
      const rt = runtime(id, cwd);
      rt.loaded = true;
      rt.permission = permission;
      rt.mode = "default";
      readConfig(rt, created.configOptions);
      if (body.model && body.model !== rt.model) await setOption(rt, "model", body.model);
      if (body.effort && body.effort !== rt.effort) await setOption(rt, "reasoning_effort", body.effort);
      if (body.mode === "plan") {
        await ag.request("session/set_mode", { sessionId: id, modeId: "plan" }, 30_000);
        rt.mode = "plan";
      }
      await prompt(id, body);
      return { sessionId: id, encoded: encodeURIComponent(cwd) };
    },

    prompt,

    async cancel(id) {
      const rt = locate(id);
      if (rt.loaded && agent?.alive && rt.running) agent.notify("session/cancel", { sessionId: id });
      return { ok: true };
    },

    async queueAction(id, entryId, action) {
      const rt = locate(id);
      if (!rt.loaded || !agent?.alive) throw new HttpError(409, "会话没有在运行");
      if (!rt.queue.some((entry) => entry.id === entryId)) throw new HttpError(404, "排队里没有这一条");
      agent.notify(action === "now" ? "_x.ai/queue/interject" : "_x.ai/queue/remove", { sessionId: id, id: entryId });
      return { ok: true };
    },

    async answer(id, requestId, body) {
      const rt = locate(id);
      const item = rt.pending.get(String(requestId));
      if (!item || !agent?.alive) throw new HttpError(404, "没有等待中的请求");
      const { interaction } = item;
      let result;
      if (interaction.kind === "permission") {
        result = body.optionId ? { outcome: { outcome: "selected", optionId: String(body.optionId) } } : { outcome: { outcome: "cancelled" } };
      } else if (interaction.kind === "question") {
        if (body.skip) result = { outcome: "skip_interview" };
        else if (body.cancel) result = { outcome: "cancelled" };
        else result = { outcome: "accepted", answers: answersOf(interaction, body.answers) };
      } else if (body.outcome === "approved" || body.outcome === "abandoned") {
        result = { outcome: body.outcome };
      } else {
        const feedback = String(body.feedback || "").trim();
        result = feedback ? { outcome: "revise", feedback } : { outcome: "revise" };
      }
      agent.respond(item.rpcId, result);
      rt.pending.delete(String(requestId));
      emit(id, { type: "interaction_resolved", requestId: String(requestId) });
      pushState(rt, true);
      return { ok: true };
    },

    async settings(id, body) {
      const rt = locate(id);
      if (body.permission !== undefined && body.permission !== rt.permission) {
        if (!PERMISSIONS.has(body.permission)) throw new HttpError(400, "未知的权限模式");
        if (rt.loaded && agent?.alive) {
          requireIdle(rt, "这一轮结束后再切换权限");
          await agent.request("_x.ai/session/close", { sessionId: id }, 30_000).catch(() => {});
          rt.loaded = false;
        }
        rt.permission = body.permission;
      }
      if (body.model) await setOption(await load(id), "model", body.model);
      if (body.effort) await setOption(await load(id), "reasoning_effort", body.effort);
      if (body.mode) {
        await load(id);
        const modeId = body.mode === "plan" ? "plan" : "default";
        await agent.request("session/set_mode", { sessionId: id, modeId }, 30_000);
        rt.mode = modeId;
      }
      pushState(rt);
      return publicState(rt);
    },

    async rename(id, body) {
      const rt = locate(id);
      const ag = await ensureAgent();
      if (body.auto) {
        await ag.request("_x.ai/session/rename", { sessionId: id, cwd: rt.cwd, resetToAuto: true }, 30_000);
        refreshFromDisk(rt);
      } else {
        const title = String(body.title || "").trim();
        if (!title) throw new HttpError(400, "标题不能为空");
        if (title.length > 200) throw new HttpError(400, "标题太长");
        const result = await ag.request("_x.ai/session/rename", { sessionId: id, cwd: rt.cwd, title }, 30_000);
        if (result?.success === false) throw new HttpError(400, result.error || "改名失败");
        rt.title = title;
      }
      pushState(rt, true);
      return { id, title: rt.title };
    },

    async trash(id) {
      const rt = locate(id);
      requireIdle(rt, "会话还在运行，先停止再删除");
      if (rt.loaded && agent?.alive) {
        await agent.request("_x.ai/session/close", { sessionId: id }, 30_000).catch(() => {});
        rt.loaded = false;
      }
      const result = store.trashSession(id, rt.cwd, { ignorePids: agent?.pid ? [agent.pid] : [] });
      runtimes.delete(id);
      emit(id, { type: "deleted" });
      return result;
    },

    async turns(id) {
      await load(id);
      const result = await agent.request("_x.ai/rewind/points", { sessionId: id }, 30_000);
      return {
        turns: (result?.rewind_points || []).map((point) => ({
          index: Number(point.prompt_index),
          preview: String(point.prompt_preview || ""),
          createdAt: point.created_at || "",
          fileChanges: Boolean(point.has_file_changes),
          files: Number(point.num_file_snapshots) || 0,
        })),
      };
    },

    async rewind(id, body) {
      const rt = await load(id);
      requireIdle(rt, "这一轮结束后再回退");
      const index = Number(body.promptIndex);
      if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "选一轮再回退");
      const result = await agent.request("_x.ai/rewind/execute", {
        sessionId: id, targetPromptIndex: index, mode: body.scope === "conversation" ? "conversation_only" : "all", force: true,
      }, 60_000);
      if (!result?.success) {
        const conflicts = (result?.conflicts || []).map((item) => item.path || item.file || "").filter(Boolean);
        throw new HttpError(400, result?.error || (conflicts.length ? `这些文件之后又被改过：${conflicts.join("、")}` : "回退失败"));
      }
      rt.turn = null;
      emit(id, { type: "reload" });
      pushState(rt, true);
      return { promptText: String(result.prompt_text || ""), revertedFiles: result.reverted_files || [] };
    },

    async fork(id, body) {
      const rt = locate(id);
      const ag = await ensureAgent();
      const params = { sourceSessionId: id, sourceCwd: rt.cwd, newCwd: rt.cwd };
      if (Number.isInteger(body.promptIndex)) params.targetPromptIndex = body.promptIndex;
      const result = await ag.request("_x.ai/session/fork", params, 60_000);
      const forked = result?.newSessionId ? String(result.newSessionId) : "";
      if (!forked) throw new HttpError(502, "Grok 没有返回分叉出的会话");
      await ag.request("_x.ai/session/rename", { sessionId: forked, cwd: rt.cwd, title: `${rt.title || "会话"} · 分叉` }, 30_000).catch(() => {});
      return { sessionId: forked, encoded: encodeURIComponent(rt.cwd) };
    },

    async btw(id, question) {
      const text = String(question || "").trim();
      if (!text) throw new HttpError(400, "问题不能为空");
      await load(id);
      const result = await agent.request("_x.ai/btw", { sessionId: id, question: text }, 180_000);
      return { answer: String(result?.result?.answer ?? result?.answer ?? "") };
    },

    plan(id) {
      const rt = locate(id);
      return { content: store.readPlan(id, rt.cwd) };
    },

    async extensions(kind, { sessionId, encoded }) {
      const ag = await ensureAgent();
      const rt = sessionId ? await load(sessionId) : null;
      const cwd = rt?.cwd || (encoded ? store.decodeProjectKey(encoded) : store.parentDir);
      const scoped = rt ? { sessionId: rt.id } : {};
      const ask = (method, params) => ag.request(method, params, 20_000);
      try {
        if (kind === "skills") {
          const result = await ask("_x.ai/skills/list", { cwd });
          return {
            items: (result?.result?.skills || []).map((skill) => ({
              name: skill.name, description: skill.short_description || skill.description || "", detail: skill.scope || "", enabled: skill.enabled !== false,
            })),
          };
        }
        if (kind === "mcp") {
          const result = await ask("_x.ai/mcp/list", scoped);
          return { items: (result?.result?.servers || []).map((server) => listItem(server, server.status || server.transport)) };
        }
        if (kind === "plugins") {
          const result = await ask("_x.ai/plugins/list", scoped);
          return { items: (result?.result?.plugins || []).map((plugin) => listItem(plugin, plugin.version)) };
        }
        if (kind === "hooks") {
          const result = await ask("_x.ai/hooks/list", scoped);
          return { items: (result?.result?.hooks || []).map((hook) => listItem(hook, hook.event || hook.source)) };
        }
        if (kind === "memory") {
          const result = await ask("_x.ai/memory/list", scoped);
          return {
            items: (result?.files || []).map((file) => listItem(file, file.path)),
            note: result?.enabled === false ? `记忆没有开启（${result.disabled_reason || "未配置"}）` : "",
          };
        }
      } catch (error) {
        return { items: [], note: error.message };
      }
      throw new HttpError(404, "没有这类扩展");
    },
  };
}

function mergeTurn(disk, live) {
  if (!live.length) return disk;
  if (live[0].role !== "user") return [...disk, ...live];
  let at = -1;
  for (let index = disk.length - 1; index >= 0; index -= 1) {
    if (disk[index].role === "user") {
      at = index;
      break;
    }
  }
  if (at >= 0 && disk[at].text.trim() === live[0].text.trim()) {
    const after = disk[at + 1];
    if (after?.role === "assistant" && after.meta) return disk;
    return [...disk.slice(0, at), ...live];
  }
  return [...disk, ...live];
}

function permissionMeta(permission) {
  return { yoloMode: permission === "yolo", autoMode: permission === "auto" };
}

function commandsOf(list) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(list) ? list : []) {
    const name = String(item?.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const meta = item._meta || {};
    result.push({
      name,
      description: String(item.description || ""),
      hint: String(item.input?.hint || ""),
      source: meta.workflowSource ? "workflow" : meta.scope ? "skill" : "grok",
    });
  }
  return result;
}

function retryOf(update) {
  if (update.type === "retrying") {
    return { attempt: Number(update.attempt) || 1, max: Number(update.max_retries) || 0, reason: String(update.reason || "") };
  }
  if (update.type === "exhausted") return { exhausted: true, reason: String(update.reason || ""), rateLimited: Boolean(update.is_rate_limited) };
  return null;
}

function answersOf(interaction, answers) {
  const result = {};
  for (const question of interaction.questions) {
    const value = answers?.[question.question];
    if (Array.isArray(value)) {
      const picked = value.map(String).filter(Boolean);
      if (picked.length) result[question.question] = question.multiSelect ? picked : picked[0];
    } else if (value != null && String(value).trim()) {
      result[question.question] = String(value).trim();
    }
  }
  return result;
}

function listItem(item, detail) {
  return {
    name: String(item?.name || item?.id || item?.command || item?.path || "未命名"),
    description: String(item?.description || item?.command || item?.summary || ""),
    detail: detail ? String(detail) : "",
    enabled: item?.enabled !== false,
  };
}
