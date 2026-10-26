import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, streamSession } from "./api.js";
import { applyUpdate, messageText } from "./transcript.js";
import { buildCatalog, parseSlash, SOURCE_LABELS, TERMINAL_ONLY } from "./commands.js";
import { MODES, effortLabel, modeKey, money, tokens } from "./format.js";
import { summarizeTools } from "./tools.js";
import Sidebar from "./components/Sidebar.jsx";
import ChatView from "./components/ChatView.jsx";
import {
  ConfirmDialog, ExtensionsDialog, ImageDialog, Modal, PlanDialog, ProjectDialog, ProjectPicker, SettingsDialog, TurnDialog,
} from "./components/Dialogs.jsx";

const EMPTY_VIEW = { ready: false, messages: [], truncated: false, state: null };
const BLANK_DRAFT = { model: "", effort: "", mode: "default", permission: "" };

function viewReducer(view, action) {
  switch (action.type) {
    case "reset":
      return EMPTY_VIEW;
    case "note":
      return { ...view, messages: [...view.messages, action.message] };
    case "events":
      return action.events.reduce(applyEvent, view);
    default:
      return view;
  }
}

function applyEvent(view, event) {
  switch (event.type) {
    case "snapshot":
      return { ready: true, messages: event.messages, truncated: event.truncated, state: event.state };
    case "state":
      return { ...view, state: event.state };
    case "update":
      return { ...view, messages: applyUpdate(view.messages, event.update, event.meta) };
    case "turn_start":
      return event.message ? { ...view, messages: [...view.messages, event.message] } : view;
    case "error":
      return { ...view, messages: [...view.messages, { role: "note", tone: "bad", text: event.message }] };
    default:
      return view;
  }
}

function readPrefs() {
  try {
    return { theme: "dark", multiline: false, thinkingOpen: false, permission: "", ...JSON.parse(localStorage.getItem("grok-web-prefs") || "{}") };
  } catch {
    return { theme: "dark", multiline: false, thinkingOpen: false, permission: "" };
  }
}

function readSet(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function selectionFromHash() {
  const hash = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
  const [kind, ...rest] = hash.split("/");
  const value = rest.join("/");
  if (kind === "s" && value) return { kind: "session", id: value, encoded: "" };
  if (kind === "p" && value) return { kind: "draft", encoded: encodeURIComponent(value) };
  return null;
}

function hashFor(selection) {
  if (selection?.kind === "session") return `#/s/${selection.id}`;
  if (selection?.kind === "draft") return `#/p/${encodeURIComponent(decodeURIComponent(selection.encoded))}`;
  return "";
}

export default function App() {
  const [state, setState] = useState(null);
  const [selection, setSelection] = useState(selectionFromHash);
  const [view, dispatch] = useReducer(viewReducer, EMPTY_VIEW);
  const [draft, setDraft] = useState(BLANK_DRAFT);
  const [pending, setPending] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [error, setError] = useState("");
  const [prefs, setPrefs] = useState(readPrefs);
  const [expanded, setExpanded] = useState(() => readSet("grok-web-expanded"));
  const [collapsed, setCollapsed] = useState(false);
  const [showList, setShowList] = useState(false);
  const [seed, setSeed] = useState(null);
  const [streamKey, setStreamKey] = useState(0);
  const refreshTimer = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      return next;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, []);

  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = 0;
      refresh();
    }, 600);
  }, [refresh]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme === "light" ? "light" : "dark";
    localStorage.setItem("grok-web-prefs", JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    localStorage.setItem("grok-web-expanded", JSON.stringify([...expanded]));
  }, [expanded]);

  useEffect(() => {
    const hash = hashFor(selection);
    if (hash && window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }, [selection]);

  useEffect(() => {
    if (selection || !state?.projects?.length) return;
    setSelection({ kind: "draft", encoded: state.projects[0].encoded });
  }, [state, selection]);

  // Keep the open session's project unfolded in the sidebar.
  useEffect(() => {
    const key = selection?.kind === "draft" ? selection.encoded : view.state?.cwd ? encodeURIComponent(view.state.cwd) : selection?.encoded;
    if (key) setExpanded((current) => (current.has(key) ? current : new Set(current).add(key)));
  }, [selection?.kind, selection?.encoded, view.state?.cwd]);

  // One event stream per open session.
  useEffect(() => {
    dispatch({ type: "reset" });
    if (selection?.kind !== "session") return undefined;
    const queue = [];
    let timer = 0;
    const flush = () => {
      timer = 0;
      dispatch({ type: "events", events: queue.splice(0) });
    };
    const stop = streamSession(selection.id, (event) => {
      if (event.type === "reload") {
        setStreamKey((key) => key + 1);
        return;
      }
      if (event.type === "deleted") {
        refresh();
        return;
      }
      if (event.type === "interaction") {
        if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Grok 在等你确认");
        return;
      }
      if (event.list || event.type === "turn_start") refreshSoon();
      queue.push(event);
      if (!timer) timer = setTimeout(flush, 30);
    }, () => {
      setPending(null);
      setError("这个会话打不开了（可能已经被删除）");
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [selection?.kind, selection?.id, streamKey, refresh, refreshSoon]);

  useEffect(() => {
    if (view.ready) setPending(null);
  }, [view.ready]);

  const defaults = state?.defaults || { model: "", effort: "", models: [], permission: "ask", commands: [] };
  const models = defaults.models || [];
  const encoded = selection?.kind === "draft"
    ? selection.encoded
    : selection?.encoded || (view.state?.cwd ? encodeURIComponent(view.state.cwd) : "");
  const project = useMemo(() => {
    const found = state?.projects?.find((item) => item.encoded === encoded);
    if (found) return found;
    const cwd = view.state?.cwd || (encoded ? decodeURIComponent(encoded) : "");
    return cwd ? { name: cwd.split("/").pop(), cwd, encoded, sessions: [] } : null;
  }, [state, encoded, view.state?.cwd]);
  const sessionRecord = selection?.kind === "session" ? project?.sessions?.find((item) => item.id === selection.id) : null;
  const catalog = useMemo(
    () => buildCatalog(view.state?.commands?.length ? view.state.commands : defaults.commands),
    [view.state?.commands, defaults.commands],
  );

  const settings = useMemo(() => {
    if (selection?.kind === "session") {
      const s = view.state;
      const model = s?.model || sessionRecord?.model || defaults.model;
      return {
        model,
        effort: s?.effort || sessionRecord?.effort || models.find((item) => item.id === model)?.effort || "",
        efforts: s?.efforts?.length ? s.efforts : models.find((item) => item.id === model)?.efforts || [],
        mode: modeKey(s?.mode, s?.permission || defaults.permission),
      };
    }
    const model = draft.model || defaults.model;
    const entry = models.find((item) => item.id === model);
    return {
      model,
      effort: draft.effort || entry?.effort || defaults.effort,
      efforts: entry?.efforts || [],
      mode: modeKey(draft.mode, draft.permission || prefs.permission || defaults.permission),
    };
  }, [selection?.kind, view.state, sessionRecord, draft, defaults, models, prefs.permission]);

  const note = (text, extra = {}) => dispatch({ type: "note", message: { role: "note", text, ...extra } });
  const fail = (err) => setError(err.message || String(err));
  const sessionId = selection?.kind === "session" ? selection.id : "";

  const expand = (key) => setExpanded((current) => (current.has(key) ? current : new Set(current).add(key)));

  const openSession = (owner, session) => {
    setError("");
    setSelection({ kind: "session", id: session.id, encoded: owner.encoded });
    expand(owner.encoded);
    setShowList(false);
  };

  const startDraft = (owner, keepSettings = false) => {
    setError("");
    if (!keepSettings) setDraft(BLANK_DRAFT);
    setSelection({ kind: "draft", encoded: owner.encoded });
    expand(owner.encoded);
    setShowList(false);
  };

  const pickProject = (keepSettings) => setDialog({
    type: "picker",
    onPick: (owner) => {
      setDialog(null);
      startDraft(owner, keepSettings);
    },
  });

  const newProject = () => setDialog({ type: "project" });

  const applySettings = async (patch) => {
    if (selection?.kind === "draft") {
      setDraft((current) => {
        const next = { ...current, ...patch };
        if (patch.model && patch.model !== current.model) next.effort = "";
        return next;
      });
      return;
    }
    if (!sessionId) return;
    try {
      await api.settings(sessionId, patch);
    } catch (err) {
      fail(err);
    }
  };

  const sendText = async (text, attachments, { now = false, draftPatch = {} } = {}) => {
    if (!selection) return false;
    setError("");
    if (selection.kind === "draft") {
      if (!project) {
        setError("先选一个项目");
        return false;
      }
      const wanted = { ...draft, ...draftPatch };
      setPending({
        text,
        images: attachments.filter((file) => file.mimeType.startsWith("image/")),
        files: attachments.filter((file) => !file.mimeType.startsWith("image/")).map((file) => file.name),
      });
      try {
        const created = await api.createSession(selection.encoded, {
          text,
          attachments,
          model: wanted.model || undefined,
          effort: wanted.effort || undefined,
          mode: wanted.mode,
          permission: wanted.permission || prefs.permission || undefined,
        });
        setSelection({ kind: "session", id: created.sessionId, encoded: created.encoded });
        setDraft(BLANK_DRAFT);
        refreshSoon();
        return true;
      } catch (err) {
        setPending(null);
        fail(err);
        return false;
      }
    }
    try {
      await api.prompt(selection.id, { text, attachments, now });
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  const requireSession = () => {
    if (sessionId) return true;
    note("这个命令要在已经开始的会话里用。");
    return false;
  };

  const exportMarkdown = () => {
    const title = view.state?.title || sessionRecord?.title || "会话";
    const body = view.messages.map((message) => {
      if (message.role === "user") return `## 你\n\n${message.text}`;
      if (message.role === "note") return `> ${message.text}`;
      const tools = message.blocks.filter((block) => block.type === "tool");
      return `## Grok\n\n${tools.length ? `_${summarizeTools(tools)}_\n\n` : ""}${messageText(message)}`;
    }).join("\n\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`# ${title}\n\n${body}\n`], { type: "text/markdown" }));
    link.download = `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const deleteSession = (id, title) => setDialog({
    type: "confirm",
    title: "删除会话",
    message: `把「${title || "这个会话"}」移到回收区（~/.grok/session-trash）？项目里的代码不会动。`,
    confirmText: "删除",
    danger: true,
    onConfirm: async () => {
      try {
        await api.trash(id);
        setDialog(null);
        if (id === sessionId && project) startDraft(project);
        refresh();
      } catch (err) {
        setDialog(null);
        fail(err);
      }
    },
  });

  const turnDialog = (purpose, preferText = "") => {
    if (!requireSession()) return;
    setDialog({
      type: "turns",
      purpose,
      preferText,
      onDone: async (body) => {
        if (purpose === "rewind") {
          const result = await api.rewind(sessionId, body);
          setDialog(null);
          if (result.promptText) setSeed({ text: result.promptText, at: Date.now() });
        } else {
          const result = await api.fork(sessionId, body);
          setDialog(null);
          await refresh();
          setSelection({ kind: "session", id: result.sessionId, encoded: result.encoded });
        }
      },
    });
  };

  const permissionToggle = (key, args) => {
    const current = view.state?.permission || draft.permission || prefs.permission || defaults.permission;
    const wanted = args === "on" ? key : args === "off" ? "ask" : current === key ? "ask" : key;
    applySettings({ mode: "default", permission: wanted });
    note(`权限：${MODES[wanted].label}（${MODES[wanted].hint}）`);
  };

  const runLocal = async (name, args) => {
    switch (name) {
      case "new":
        if (project) startDraft(project);
        else pickProject(false);
        return;
      case "home":
        if (project) startDraft(project);
        return;
      case "resume": {
        const pool = args ? (state?.projects || []).flatMap((item) => item.sessions.map((session) => ({ project: item, session }))) : [];
        const needle = args.toLowerCase();
        const hits = pool.filter(({ session }) => session.id.startsWith(args) || session.title.toLowerCase().includes(needle));
        if (hits.length === 1) openSession(hits[0].project, hits[0].session);
        else if (hits.length > 1) note(`有 ${hits.length} 个会话匹配：\n${hits.slice(0, 10).map(({ project: owner, session }) => `· ${session.title}（${owner.name}）`).join("\n")}`);
        else note(args ? "没有匹配的会话" : "在左边选一个会话打开，或输入 /resume 加标题。");
        return;
      }
      case "rename":
        if (!requireSession()) return;
        if (!args) {
          setDialog({ type: "rename" });
          return;
        }
        await api.rename(sessionId, args === "--auto" ? { auto: true } : { title: args });
        refresh();
        note(args === "--auto" ? "标题交回自动生成" : `标题改成了「${args}」`);
        return;
      case "fork":
        turnDialog("fork");
        return;
      case "rewind":
        turnDialog("rewind");
        return;
      case "btw": {
        if (!requireSession()) return;
        if (!args) {
          note("用法：/btw 你的问题");
          return;
        }
        note(`旁问「${args}」，等 Grok 回答…`);
        const { answer } = await api.btw(sessionId, args);
        note(answer || "（没有回答）", { tone: "btw", question: args });
        return;
      }
      case "model": {
        if (!args) {
          note(`模型：${settings.model}\n可选：${models.map((item) => item.id).join("、")}\n也可以点输入框右下角的模型切换。`);
          return;
        }
        const found = models.find((item) => item.id.toLowerCase() === args.toLowerCase() || item.name.toLowerCase() === args.toLowerCase());
        if (!found) {
          note(`没有模型 ${args}。可选：${models.map((item) => item.id).join("、")}`);
          return;
        }
        await applySettings({ model: found.id });
        return;
      }
      case "effort": {
        const options = settings.efforts.map((item) => item.id);
        if (!args) {
          note(`推理强度：${effortLabel(settings.effort)}\n可选：${options.map((id) => `${id}（${effortLabel(id)}）`).join("、")}`);
          return;
        }
        if (!options.includes(args)) {
          note(`${settings.model} 没有 ${args} 这一档。可选：${options.join("、")}`);
          return;
        }
        await applySettings({ effort: args });
        return;
      }
      case "plan":
        await applySettings({ mode: "plan" });
        if (args) await sendText(args, [], { draftPatch: { mode: "plan" } });
        else note("已进入计划模式：Grok 只读代码、写计划，你批准之后才会改文件。");
        return;
      case "view-plan":
        if (requireSession()) setDialog({ type: "plan" });
        return;
      case "always-approve":
        permissionToggle("yolo", args);
        return;
      case "auto":
        permissionToggle("auto", args);
        return;
      case "usage": {
        const usage = view.state?.usage;
        if (!usage?.total) {
          note("这个会话还没有用量。");
          return;
        }
        note([
          `**本会话用量** · ${usage.turns} 轮 · ${usage.calls} 次模型调用`,
          `- 总计 ${tokens(usage.total)} tok，费用约 ${money(usage.cost)}`,
          `- 输入 ${tokens(usage.input)}（缓存命中 ${tokens(usage.cached)}）`,
          `- 输出 ${tokens(usage.output)}（推理 ${tokens(usage.reasoning)}）`,
        ].join("\n"), { markdown: true });
        return;
      }
      case "skills":
      case "mcps":
      case "plugins":
      case "hooks":
      case "memory":
        setDialog({ type: "extensions", initial: { mcps: "mcp" }[name] || name });
        return;
      case "copy": {
        const replies = view.messages.filter((message) => message.role === "assistant" && messageText(message));
        const nth = Math.max(1, Number(args) || 1);
        const target = replies.at(-nth);
        if (!target) {
          note("还没有可以复制的回复。");
          return;
        }
        await navigator.clipboard.writeText(messageText(target));
        note(nth === 1 ? "已复制最近一条回复" : `已复制倒数第 ${nth} 条回复`);
        return;
      }
      case "export":
        if (requireSession()) exportMarkdown();
        return;
      case "delete":
        if (requireSession()) deleteSession(sessionId, view.state?.title);
        return;
      case "history":
        note("在空输入框里按 ↑ ↓ 翻看这个会话发过的消息。");
        return;
      case "multiline":
        setPrefs((current) => ({ ...current, multiline: !current.multiline }));
        note(prefs.multiline ? "多行输入已关：Enter 发送" : "多行输入已开：Enter 换行，Shift+Enter 发送");
        return;
      case "theme":
        setPrefs((current) => ({ ...current, theme: current.theme === "light" ? "dark" : "light" }));
        return;
      case "settings":
        setDialog({ type: "settings" });
        return;
      case "docs":
        window.open("https://docs.x.ai/build/overview", "_blank", "noreferrer");
        return;
      case "help":
        note(catalog.map((item) => `\`/${item.name}${item.hint ? ` ${item.hint}` : ""}\` ${item.summary} · ${SOURCE_LABELS[item.source] || item.source}`).join("  \n"), { markdown: true });
        return;
      default:
        note(`/${name} 还没有接上`);
    }
  };

  const submit = async (text, attachments, options = {}) => {
    const parsed = attachments.length ? null : parseSlash(text, catalog);
    if (parsed?.command?.source === "web") {
      try {
        await runLocal(parsed.command.name, parsed.args);
      } catch (err) {
        fail(err);
      }
      return true;
    }
    if (parsed && !parsed.command) {
      const terminal = TERMINAL_ONLY[parsed.token];
      note(terminal ? `/${parsed.token}（${terminal}）只在终端界面里有。` : `没有 /${parsed.token} 这个命令，输入 / 看看都有哪些。`);
      return true;
    }
    return sendText(text, attachments, options);
  };

  const onAction = (action, context = {}) => {
    const userText = () => {
      const index = context.index ?? -1;
      for (let at = index; at >= 0; at -= 1) {
        if (context.messages?.[at]?.role === "user") return context.messages[at].text;
      }
      return "";
    };
    switch (action) {
      case "rename":
        setDialog({ type: "rename" });
        return;
      case "fork":
        turnDialog("fork", userText());
        return;
      case "rewind":
        turnDialog("rewind", userText());
        return;
      case "view-plan":
        setDialog({ type: "plan" });
        return;
      case "extensions":
        setDialog({ type: "extensions", initial: "skills" });
        return;
      case "export":
        exportMarkdown();
        return;
      case "delete":
        deleteSession(sessionId, view.state?.title);
        return;
      case "copy-failed":
        setError("浏览器不让复制，换个浏览器或用 /copy 试试");
        return;
      default:
    }
  };

  const closeDialog = () => setDialog(null);

  return (
    <div className={`app ${collapsed ? "collapsed" : ""} ${showList ? "show-list" : ""}`}>
      <Sidebar
        state={state}
        selection={selection}
        expanded={expanded}
        onToggleProject={(key) => setExpanded((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        })}
        onOpenSession={openSession}
        onNewSession={() => pickProject(false)}
        onNewSessionIn={(owner) => startDraft(owner)}
        onNewProject={newProject}
        onRemoveProject={(owner) => setDialog({
          type: "confirm",
          title: "从列表移除",
          message: `把「${owner.name}」从列表移除？只是不显示，不会删除 ${owner.cwd} 里的代码和会话记录。`,
          confirmText: "移除",
          onConfirm: async () => {
            await api.removeProject(owner.encoded).catch(fail);
            setDialog(null);
            if (owner.encoded === encoded) setSelection(null);
            refresh();
          },
        })}
        onRenameSession={async (session, title) => {
          try {
            await api.rename(session.id, { title });
            refresh();
          } catch (err) {
            fail(err);
          }
        }}
        onDeleteSession={(session) => deleteSession(session.id, session.title)}
        onSettings={() => setDialog({ type: "settings" })}
        onCollapse={() => setCollapsed(true)}
      />
      {collapsed && (
        <button type="button" className="expand-side" aria-label="展开边栏" onClick={() => setCollapsed(false)}>»</button>
      )}
      <div className="side-shade" onClick={() => setShowList(false)} />
      <ChatView
        selection={selection}
        view={view}
        project={project}
        sessionTitle={view.state?.title || sessionRecord?.title}
        settings={settings}
        models={models}
        catalog={catalog}
        sessions={project?.sessions || []}
        pending={pending}
        prefs={prefs}
        error={error}
        seed={seed}
        onDismissError={() => setError("")}
        onSubmit={submit}
        onStop={() => sessionId && api.cancel(sessionId).catch(fail)}
        onSettings={applySettings}
        onQueue={(entryId, action) => api.queue(sessionId, entryId, action).catch(fail)}
        onAnswer={(requestId, body) => api.answer(sessionId, requestId, body).catch(fail)}
        onRejectWith={async (requestId, optionId, text) => {
          try {
            await api.answer(sessionId, requestId, { optionId });
            await api.prompt(sessionId, { text });
          } catch (err) {
            fail(err);
          }
        }}
        onRename={async (title) => {
          try {
            await api.rename(sessionId, { title });
            refresh();
          } catch (err) {
            fail(err);
          }
        }}
        onAction={onAction}
        onPickProject={() => pickProject(true)}
        onShowList={() => setShowList(true)}
        onImage={(image) => setDialog({ type: "image", image })}
      />
      {dialog?.type === "project" && (
        <ProjectDialog
          parent={state?.parent || ""}
          onCancel={closeDialog}
          onCreate={async (body) => {
            const created = await api.createProject(body);
            setDialog(null);
            await refresh();
            startDraft(created);
          }}
        />
      )}
      {dialog?.type === "picker" && (
        <ProjectPicker
          projects={state?.projects || []}
          current={encoded}
          onPick={dialog.onPick}
          onNewProject={newProject}
          onClose={closeDialog}
        />
      )}
      {dialog?.type === "confirm" && <ConfirmDialog {...dialog} onClose={closeDialog} />}
      {dialog?.type === "turns" && (
        <TurnDialog sessionId={sessionId} purpose={dialog.purpose} preferText={dialog.preferText} onDone={dialog.onDone} onClose={closeDialog} />
      )}
      {dialog?.type === "extensions" && <ExtensionsDialog initial={dialog.initial} sessionId={sessionId} encoded={encoded} onClose={closeDialog} />}
      {dialog?.type === "plan" && <PlanDialog sessionId={sessionId} onClose={closeDialog} />}
      {dialog?.type === "settings" && <SettingsDialog prefs={prefs} onChange={(patch) => setPrefs((current) => ({ ...current, ...patch }))} onClose={closeDialog} />}
      {dialog?.type === "image" && <ImageDialog image={dialog.image} onClose={closeDialog} />}
      {dialog?.type === "rename" && (
        <RenameDialog
          title={view.state?.title || sessionRecord?.title || ""}
          onClose={closeDialog}
          onSave={async (title) => {
            await api.rename(sessionId, title === "" ? { auto: true } : { title });
            setDialog(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function RenameDialog({ title, onSave, onClose }) {
  const [value, setValue] = useState(title);
  const [error, setError] = useState("");
  return (
    <Modal title="重命名会话" onClose={onClose} testId="rename-dialog">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onSave(value.trim());
          } catch (err) {
            setError(err.message);
          }
        }}
      >
        <input className="field" value={value} autoFocus onChange={(event) => setValue(event.target.value)} />
        <p className="faint-line">留空保存会交回 Grok 自动起名。</p>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary">保存</button>
        </div>
      </form>
    </Modal>
  );
}
