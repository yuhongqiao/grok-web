import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Icon, { Spinner } from "../components/Icon.jsx";
import WorkspaceSwitch from "../components/WorkspaceSwitch.jsx";
import { ConfirmDialog, Modal } from "../components/Dialogs.jsx";
import { ago, tokens } from "../format.js";
import { codexApi, streamThread } from "./api.js";
import { applyThreadEvent, runningTurn, threadTitle } from "./protocol.js";
import { CodexTurn, CodexTrace, exportThread } from "./Transcript.jsx";
import CodexInteraction from "./Interactions.jsx";
import CodexComposer, { commandHelp } from "./Composer.jsx";
import { draftKey, saveAttachments } from "./drafts.js";
import { threadLocation, threadLink, resumeCommand } from "./links.js";
import BrowserPanel from "./BrowserPanel.jsx";
import BrowserSession from "./BrowserSession.jsx";
import { isBrowserCall } from "./browser.js";
import { permissionLabel, approvalLabel } from "./permissions.js";
import WorkspacePanel from "./WorkspacePanel.jsx";
import "./codex.css";

const EMPTY = { thread: null, settings: {}, busy: false, interactions: [], queue: [], queuePaused: false };

export default function CodexApp() {
  const [state, setState] = useState(null);
  const [id, setId] = useState(() => threadLocation().id);
  const [focusTurn, setFocusTurn] = useState(() => threadLocation().turnId);
  const [cwd, setCwd] = useState(() => sessionStorage.getItem("codex-web-cwd") || "");
  const [view, setView] = useState(EMPTY);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [query, setQuery] = useState("");
  const [searchPage, setSearchPage] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [showList, setShowList] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [extraThreads, setExtraThreads] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [limit, setLimit] = useState(40);
  const [theme, setTheme] = useState(() => localStorage.getItem("codex-web-theme") || "dark");
  const [tab, setTab] = useState("chat");
  const [image, setImage] = useState("");
  const [notice, setNotice] = useState("");
  const [pins, setPins] = useState(() => { try { const value = JSON.parse(localStorage.getItem("codex-web-pins") || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } });
  const [notify, setNotify] = useState(() => localStorage.getItem("codex-web-notify") === "true");
  const lastLive = useRef({});
  const locatedTurn = useRef("");
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem("codex-web-collapsed") || "[]"); } catch { return []; }
  });
  const search = useRef(null);
  const scroller = useRef(null);
  const stick = useRef(true);
  const currentId = useRef(id);
  currentId.current = id;
  const searchRequest = useRef({ query });
  if (searchRequest.current.query !== query) searchRequest.current = { query };

  const refresh = useCallback(async () => {
    try { setState(await codexApi.state()); } catch (err) { setError(err.message); }
  }, []);

  useEffect(() => {
    document.title = "Codex Web";
    refresh();
    const timer = setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    const navigate = () => { const location = threadLocation(); setId(location.id); setFocusTurn(location.turnId); locatedTurn.current = ""; setTab("chat"); };
    window.addEventListener("hashchange", navigate);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("hashchange", navigate); };
  }, [refresh]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codex-web-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!cwd && state?.projects.length) setCwd(state.projects[0].cwd);
  }, [state, cwd]);

  useEffect(() => { sessionStorage.setItem("codex-web-cwd", cwd); }, [cwd]);

  useEffect(() => {
    setView(EMPTY);
    setLimit(40);
    stick.current = !threadLocation().turnId;
    if (!id) return;
    let active = true;
    const stop = streamThread(id, (event) => {
      if (!active) return;
      if (event.type === "snapshot") {
        setView(event);
        setConnectionError("");
      } else if (event.type === "event") {
        setView((current) => {
          const thread = applyThreadEvent(current.thread, event.event);
          const running = Boolean(runningTurn(thread));
          return { ...current, thread, busy: event.event.method === "turn/completed" ? running : current.busy || running };
        });
        if (["turn/completed", "thread/name/updated"].includes(event.event.method)) refresh();
        if (event.event.method === "error" && !event.event.params.willRetry) setError(event.event.params.error?.message || "Codex 执行失败");
      } else if (["interactions", "settings", "busy"].includes(event.type)) {
        setView((current) => ({ ...current, [event.type]: event[event.type] }));
      } else if (event.type === "queue") {
        setView((current) => ({ ...current, queue: event.queue, queuePaused: event.queuePaused }));
      } else if (event.type === "error") setError(event.message);
      else if (event.type === "archived") { selectThread(""); refresh(); }
    }, (closed) => {
      if (active) setConnectionError(closed ? "无法打开 Codex 会话，请点击重连。" : "Codex 连接暂时断开，正在重连…");
    });
    return () => { active = false; stop(); };
  }, [id, streamKey, refresh]);

  const thread = view.thread?.id === id ? view.thread : null;
  const browserCall = useMemo(() => thread?.turns.flatMap((turn) => turn.items).filter(isBrowserCall).at(-1), [thread]);
  const busy = view.busy || sending;
  useEffect(() => {
    let active = true;
    setSearchPage(null); setSearchError(""); setSearching(Boolean(query.trim())); setLoadingMore(false);
    if (!query.trim()) return;
    const timer = setTimeout(() => codexApi.threads("", false, query).then((page) => { if (active) setSearchPage(page); }).catch((err) => { if (active) setSearchError(err.message); }).finally(() => { if (active) setSearching(false); }), 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  const threads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const loaded = [...extraThreads, ...(state?.threads || [])];
    const entries = needle ? [...loaded.filter((entry) => `${threadTitle(entry)} ${entry.cwd}`.toLowerCase().includes(needle)), ...(searchPage?.threads || [])] : loaded;
    return [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id)) || b.updatedAt - a.updatedAt);
  }, [state, extraThreads, query, searchPage, pins]);
  const projects = useMemo(() => {
    const grouped = new Map((state?.projects || []).map((project) => [project.cwd, { ...project, threads: [] }]));
    for (const entry of threads) {
      if (!grouped.has(entry.cwd)) grouped.set(entry.cwd, { cwd: entry.cwd, name: entry.cwd.split("/").pop() || entry.cwd, threads: [] });
      grouped.get(entry.cwd).threads.push(entry);
    }
    const needle = query.trim().toLowerCase();
    return [...grouped.values()].filter((project) => !needle || project.threads.length || project.cwd.toLowerCase().includes(needle));
  }, [state, threads, query]);

  useEffect(() => { localStorage.setItem("codex-web-collapsed", JSON.stringify(collapsed)); }, [collapsed]);
  useEffect(() => { localStorage.setItem("codex-web-pins", JSON.stringify(pins)); }, [pins]);
  useEffect(() => { localStorage.setItem("codex-web-notify", String(notify)); }, [notify]);
  useEffect(() => {
    if (!state) return;
    if (notify && "Notification" in window && Notification.permission === "granted") {
      for (const [threadId, live] of Object.entries(state.live)) if (lastLive.current[threadId] && live.lastCompletedTurnId && lastLive.current[threadId].lastCompletedTurnId !== live.lastCompletedTurnId) {
        const title = threadTitle(threads.find((entry) => entry.id === threadId));
        const notification = new Notification("Codex 任务已结束", { body: title, tag: threadId });
        notification.onclick = () => { window.focus(); selectThread(threadId); notification.close(); };
      }
    }
    lastLive.current = state.live;
  }, [state, notify]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 2500); return () => clearTimeout(timer); }, [notice]);

  useLayoutEffect(() => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [thread, view.interactions]);
  useLayoutEffect(() => {
    const key = `${id}/${focusTurn}`;
    if (!focusTurn || !thread || locatedTurn.current === key || tab !== "chat") return;
    const index = thread.turns.findIndex((turn) => turn.id === focusTurn);
    if (index < 0) return;
    stick.current = false;
    if (thread.turns.length - index > limit) { setLimit(thread.turns.length - index); return; }
    const element = [...(scroller.current?.querySelectorAll("[data-turn-id]") || [])].find((entry) => entry.dataset.turnId === focusTurn);
    if (element) { element.scrollIntoView({ block: "start" }); locatedTurn.current = key; element.classList.add("codex-linked-turn"); }
  }, [thread, focusTurn, id, limit, tab]);

  function selectThread(nextId, nextCwd) {
    setShowList(false);
    if (nextCwd) setCwd(nextCwd);
    setFocusTurn(""); locatedTurn.current = "";
    if (nextId === id) { window.history.replaceState(null, "", nextId ? `#/t/${encodeURIComponent(nextId)}` : "#/new"); return; }
    currentId.current = nextId;
    setId(nextId);
    setView(EMPTY);
    setError("");
    setConnectionError("");
    setTab("chat");
    window.history.pushState(null, "", nextId ? `#/t/${nextId}` : "#/new");
  }

  async function submit(text, options = {}) {
    setSending(true);
    setError("");
    let target = id;
    try {
      if (!target) {
        const created = await codexApi.create({ cwd, ...options });
        target = created.thread.id;
      }
      await codexApi.prompt(target, { text, ...options });
      if (target !== id && currentId.current === id) selectThread(target);
      refresh();
      return true;
    } catch (err) {
      if (target && target !== id) {
        sessionStorage.setItem(draftKey(target), text);
        if (options.attachments?.length) await saveAttachments(target, options.attachments).catch(() => {});
        sessionStorage.setItem(`${draftKey(target)}:options`, JSON.stringify({ model: options.model, effort: options.effort, mode: options.mode, permissions: options.permissions, approvalPolicy: options.approvalPolicy, collaborationMode: options.collaborationMode, skills: options.skills }));
        if (currentId.current === id) selectThread(target);
      }
      if (currentId.current === id || currentId.current === target) setError(err.message);
      return false;
    } finally { setSending(false); }
  }

  const retry = () => { setError(""); setConnectionError(""); setStreamKey((value) => value + 1); refresh(); };
  const visibleError = error || connectionError;
  const nextCursor = query.trim() ? searchPage?.nextCursor : cursor === undefined ? state?.nextCursor : cursor;

  async function fork(lastTurnId) {
    const source = id;
    setSending(true);
    try {
      const created = await codexApi.fork(source, lastTurnId);
      await refresh();
      if (currentId.current === source) selectThread(created.thread.id, created.thread.cwd);
    } finally { setSending(false); }
  }

  async function command(name) {
    if (name === "new") { selectThread(""); return; }
    if (name === "resume") { setShowList(true); search.current?.focus(); return; }
    if (name === "help") { setDialog({ type: "help" }); return; }
    if (name === "browser" || name === "workspace") { setTab(name === "browser" ? "browser" : "develop"); return; }
    if (name === "notify") {
      if (notify) { setNotify(false); return; }
      if (!("Notification" in window)) throw new Error("当前浏览器不支持系统通知");
      if (await Notification.requestPermission() !== "granted") throw new Error("请在浏览器站点权限中允许通知");
      setNotify(true); return;
    }
    if (!thread) throw new Error("请先打开一个会话");
    if (name === "rename" || name === "archive" || name === "status") setDialog({ type: name });
    else if (name === "fork") await fork();
    else if (name === "compact") await codexApi.compact(id);
    else if (name === "review") await codexApi.review(id, { type: "uncommittedChanges" });
    else if (name === "pin") setPins((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
    else if (["link", "id", "resume-cli"].includes(name)) {
      await navigator.clipboard.writeText(name === "link" ? threadLink(id) : name === "id" ? id : resumeCommand(thread.cwd, id));
      setNotice(name === "resume-cli" ? "已复制 CLI 恢复命令" : "已复制");
    }
    else if (name === "open") window.open(threadLink(id), "_blank", "noopener");
    else if (name === "retry" || name === "undo") {
      if (busy || view.queue.length) throw new Error("请先等待任务结束并处理排队消息");
      const turn = name === "retry" ? thread.turns.findLast((turn) => turn.items.some((item) => item.type === "userMessage")) : thread.turns.at(-1);
      if (!turn) throw new Error("没有可操作的历史轮次");
      if (name === "undo" && thread.historyMode !== "paginated") throw new Error("旧版历史不支持原地回退，请使用编辑或重试创建分支");
      setDialog({ type: "revise", action: name === "retry" ? "retry" : "revert", turn });
    }
    else if (name === "copy") {
      const replies = thread.turns.flatMap((turn) => turn.items).filter((item) => item.type === "agentMessage" && item.text);
      if (!replies.length) throw new Error("还没有可以复制的回复");
      await navigator.clipboard.writeText(replies.at(-1).text);
    } else if (name === "export" || name === "export-json") {
      const json = name === "export-json";
      const url = URL.createObjectURL(new Blob([json ? JSON.stringify(thread, null, 2) : exportThread(thread)], { type: json ? "application/json" : "text/markdown;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `${threadTitle(thread).replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 80)}.${json ? "json" : "md"}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  const action = (name) => command(name).catch((err) => setError(err.message));
  const queueAction = (entryId, name) => codexApi.queue(id, entryId, name, runningTurn(thread)?.id).catch((err) => setError(err.message));

  async function editQueue(entry) {
    try { await codexApi.queue(id, "all", "pause"); setDialog({ type: "queueEdit", entry }); } catch (err) { setError(err.message); }
  }

  return (
    <div className={`app codex-app ${showList ? "show-list" : ""}`}>
      <aside className="sidebar">
        <div className="brand-row"><div className="brand"><span className="codex-mark"><Icon name="terminal" size={22} /></span><strong>Codex</strong><span className="brand-badge">local</span></div></div>
        <WorkspaceSwitch active="codex" />
        <button className="new-chat" data-testid="codex-new-chat" onClick={() => selectThread("")}><Icon name="plusCircle" size={17} />新会话</button>
        <div className="section-head"><span className="section-label">Codex 工作区</span><span className="spacer" /><button className="icon-button" aria-label="已归档的 Codex 会话" onClick={() => setDialog({ type: "archives" })}><Icon name="clock" /></button><button className="icon-button" aria-label="添加 Codex 项目" onClick={() => setDialog({ type: "project" })}><Icon name="folderPlus" /></button></div>
        <input ref={search} className="side-search" aria-label="搜索 Codex 会话" placeholder="搜索项目、会话或历史内容" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="side-scroll">
          {searching && <div className="side-empty"><Spinner /> 搜索完整历史…</div>}
          {searchError && <p className="error-text">{searchError}</p>}
          {!state && <div className="side-empty">{error ? "Codex 尚未连接" : <Spinner />}</div>}
          {state && !projects.length && !searching && <div className="side-empty">{query.trim() ? "没有匹配的项目或会话" : "添加项目目录，开始第一个会话"}</div>}
          {projects.map((project) => (
            <div className="project" key={project.cwd}>
              <div className="codex-project-row"><button className="icon-button" aria-label={`折叠项目 ${project.name}`} aria-expanded={!collapsed.includes(project.cwd)} onClick={() => setCollapsed((current) => current.includes(project.cwd) ? current.filter((entry) => entry !== project.cwd) : [...current, project.cwd])}><Icon name={collapsed.includes(project.cwd) ? "chevronRight" : "chevronDown"} size={13} /></button><button className={`project-row ${!id && cwd === project.cwd ? "on" : ""}`} title={project.cwd} onClick={() => selectThread("", project.cwd)}><Icon name="folderOpen" size={16} /><span className="project-name">{project.name}</span><Icon name="plus" size={14} /></button></div>
              {(!collapsed.includes(project.cwd) || query) && project.threads.map((entry) => (
                <div className={`session-line ${entry.id === id ? "current" : ""}`} key={entry.id}>
                  <button className="session-row" data-testid="codex-session" data-thread-id={entry.id} title={entry.snippet || threadTitle(entry)} onClick={() => selectThread(entry.id, entry.cwd)}><span className="session-title">{pins.includes(entry.id) && "★ "}{threadTitle(entry)}{query.trim() && entry.snippet && <small className="codex-search-snippet">{entry.snippet}</small>}</span>{state.live[entry.id]?.waiting ? <span className="dot warn" title="等待确认" /> : state.live[entry.id]?.busy ? <Spinner size={12} /> : <span className="session-age">{ago(entry.updatedAt * 1000)}</span>}</button>
                </div>
              ))}
            </div>
          ))}
          {nextCursor && <button className="session-more" disabled={loadingMore} onClick={async () => {
            const request = searchRequest.current;
            setLoadingMore(true);
            try { const page = await codexApi.threads(nextCursor, false, query); if (searchRequest.current !== request) return; if (query.trim()) setSearchPage((current) => ({ ...page, threads: [...(current?.threads || []), ...page.threads] })); else { setExtraThreads((current) => [...current, ...page.threads]); setCursor(page.nextCursor); } } catch (err) { if (searchRequest.current === request) setError(err.message); } finally { if (searchRequest.current === request) setLoadingMore(false); }
          }}>{loadingMore ? "加载中…" : "加载更早的会话"}</button>}
        </div>
        <div className="side-foot codex-side-foot"><span><i className={`dot ${state?.account.authenticated ? "codex-connected" : "warn"}`} />{state?.account.authenticated ? "本地 Codex 已连接" : "等待本地 Codex"}</span><button className="icon-button" aria-label="切换 Codex 主题" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} /></button></div>
      </aside>
      <div className="side-shade" onClick={() => setShowList(false)} />
      <main className="main">
        <header className="chat-head">
          <button className="icon-button only-mobile" aria-label="Codex 会话列表" onClick={() => setShowList(true)}><Icon name="sidebar" size={18} /></button>
          <h1 className="chat-title">{id ? threadTitle(thread || threads.find((entry) => entry.id === id)) : "新会话"}</h1>
          <span className="head-project" title={thread?.cwd || cwd}><Icon name="folder" size={13} />{(thread?.cwd || cwd).split("/").pop()}</span>
          <span className="spacer" />
          {thread && <><button className="icon-button" aria-label="重命名 Codex 会话" onClick={() => setDialog({ type: "rename" })}><Icon name="pencil" /></button><button className="icon-button" aria-label="归档 Codex 会话" disabled={busy} onClick={() => setDialog({ type: "archive" })}><Icon name="trash" /></button></>}
          <details className="codex-menu"><summary className="icon-button" aria-label="Codex 更多操作"><Icon name="more" /></summary><div>{[["link", "link", "复制会话链接"], ["id", "copy", "复制会话 ID"], ["resume-cli", "terminal", "复制 CLI 恢复命令"], ["open", "globe", "在新标签页打开"], ["pin", "star", pins.includes(id) ? "取消置顶" : "置顶会话"], ["fork", "fork", "分叉会话"], ["compact", "database", "压缩上下文"], ["review", "check", "审查未提交修改"], ["copy", "copy", "复制最新回复"], ["export", "download", "导出 Markdown"], ["export-json", "download", "导出 JSON"], ["notify", "bell", notify ? "关闭完成通知" : "开启完成通知"], ["status", "gauge", "会话信息"], ["help", "list", "快捷操作"]].map(([name, icon, label]) => <button key={name} disabled={!["help", "notify"].includes(name) && (!thread || (["fork", "compact", "review"].includes(name) && busy))} onClick={(event) => { event.currentTarget.closest("details").open = false; action(name); }}><Icon name={icon} />{label}</button>)}</div></details>
        </header>
        {(thread || cwd) && <div className="tabs"><button className={`tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>对话</button><button className={`tab ${tab === "trace" ? "active" : ""}`} onClick={() => setTab("trace")}>轨迹</button><button className={`tab ${tab === "browser" ? "active" : ""}`} onClick={() => setTab("browser")}>浏览器测试</button><button className={`tab ${tab === "develop" ? "active" : ""}`} onClick={() => setTab("develop")}>开发面板</button></div>}
        {notice && <div className="codex-notice" role="status">{notice}</div>}
        {tab === "browser" && <BrowserPanel key={thread?.cwd || cwd} cwd={thread?.cwd || cwd} onAsk={async (text, attachments) => { setTab("chat"); if (!await submit(text, { attachments })) throw new Error("发送失败，请在对话中检查错误和草稿"); }} />}
        {tab === "develop" && <WorkspacePanel key={thread?.cwd || cwd} cwd={thread?.cwd || cwd} threadId={id} busy={busy || Boolean(view.queue.length)} onReview={() => setTab("chat")} onAsk={async (text) => { setTab("chat"); if (!await submit(text)) throw new Error("发送失败，请检查对话中的错误"); }} />}
        <div className="codex-conversation" style={!["chat", "trace"].includes(tab) ? { display: "none" } : undefined}><div className="codex-conversation-main">
        <div className="codex-scroll" style={!["chat", "trace"].includes(tab) ? { display: "none" } : undefined} ref={scroller} onScroll={() => { const element = scroller.current; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120; }}>
          <div className="column">
            {!id && <div className="codex-welcome"><span className="codex-mark large"><Icon name="terminal" size={32} /></span><h2>在你的项目里，和 Codex 一起工作</h2><p>选择本地项目，开始对话或继续 CLI 会话。</p><span className="codex-welcome-path mono">{cwd || "还没有选择项目目录"}</span><button className="btn" onClick={() => setDialog({ type: "project" })}><Icon name="folderPlus" />添加项目</button></div>}
            {id && !thread && !visibleError && <div className="loading"><Spinner />正在恢复 Codex 会话…</div>}
            {thread?.turns.length > limit && <button className="more-button" onClick={() => { stick.current = false; setLimit((value) => value + 40); }}>显示更早的对话</button>}
            {tab === "trace" ? <CodexTrace turns={thread?.turns.slice(-limit) || []} /> : thread?.turns.slice(-limit).map((turn) => <CodexTurn key={turn.id} turn={turn} threadId={id} onImage={setImage} canFork={!busy && !view.queue.length} canRevert={thread.historyMode === "paginated"} onRevise={(action) => setDialog({ type: "revise", action, turn })} onFork={() => fork(turn.id).catch((err) => setError(err.message))} onError={setError} />)}
          </div>
        </div>
        {visibleError && <div className="codex-error" role="alert"><Icon name="alert" /><span>{visibleError}</span><button className="btn" onClick={retry}>重连</button><button className="icon-button" aria-label="关闭错误" onClick={() => { setError(""); setConnectionError(""); }}><Icon name="x" /></button></div>}
        <div className="dock" style={!["chat", "trace"].includes(tab) ? { display: "none" } : undefined}><div className="column">
          {(view.interactions.length > 0 || view.queue.length > 0) && <div className="codex-pending">
          <div className="codex-interactions">{view.interactions.map((request) => <CodexInteraction key={request.id} request={request} thread={thread} onAnswer={(body) => codexApi.answer(id, request.id, body)} />)}</div>
          {view.queue.length > 0 && <div className="codex-queue" data-testid="codex-queue"><div className="codex-queue-head"><span><Icon name="list" />{view.queuePaused ? "队列已暂停" : "等待当前任务结束"} · {view.queue.length}</span><button type="button" className="meta-button" onClick={() => queueAction("all", view.queuePaused ? "resume" : "pause")}>{view.queuePaused ? "继续队列" : "暂停队列"}</button></div>{view.queue.map((entry, index) => <div className="codex-queue-entry" key={entry.id}><span title={[entry.text, ...entry.files, ...entry.skills].join("\n")}>{entry.sending ? "发送中…" : entry.text || entry.files.join("、")}{entry.error && <small className="error-text">{entry.error}</small>}</span><button type="button" className="icon-button" aria-label="编辑排队消息" disabled={entry.sending} onClick={() => editQueue(entry)}><Icon name="pencil" size={13} /></button><button type="button" className="icon-button" aria-label="上移排队消息" disabled={entry.sending || index === 0 || view.queue[index - 1]?.sending} onClick={() => queueAction(entry.id, "up")}><Icon name="arrowUp" size={13} /></button><button type="button" className="icon-button" aria-label="下移排队消息" disabled={entry.sending || index === view.queue.length - 1} onClick={() => queueAction(entry.id, "down")}><Icon name="chevronDown" size={13} /></button>{runningTurn(thread) && <button type="button" className="meta-button" disabled={entry.sending} onClick={() => queueAction(entry.id, "steer")}>立即补充</button>}<button type="button" className="icon-button" aria-label="移除排队消息" disabled={entry.sending} onClick={() => queueAction(entry.id, "remove")}><Icon name="x" size={13} /></button></div>)}</div>}
          </div>}
          <CodexComposer
            key={id || `new:${cwd}`}
            storageKey={id || `new:${cwd}`}
            ready={Boolean(state && (id ? thread : cwd))}
            busy={busy}
            submitting={sending}
            turnId={runningTurn(thread)?.id}
            canStop={Boolean(runningTurn(thread)) && !sending}
            models={state?.models || []}
            collaborationModes={state?.collaborationModes || []}
            settings={view.settings}
            projects={state?.projects || []}
            cwd={thread?.cwd || cwd}
            isNew={!id}
            onProject={setCwd}
            onAddProject={() => setDialog({ type: "project" })}
            onSubmit={submit}
            onCommand={command}
            onStop={() => codexApi.cancel(id).catch((err) => setError(err.message))}
          />
          <div className="codex-status"><span>{view.interactions.length ? "等待你的确认" : busy ? "Codex 正在运行 · 切换工作台后会继续" : "Enter 发送 · Shift+Enter 换行 · ↑ 历史输入"}</span><button className="meta-button" onClick={() => action(thread ? "status" : "help")}>{thread?.tokenUsage?.total?.totalTokens > 0 ? `${tokens(thread.tokenUsage.total.totalTokens)} tok` : "快捷操作"}</button></div>
        </div></div>
        </div>{browserCall && <BrowserSession key={`${id}:${browserCall.arguments?.projectPath || thread.cwd}:${browserCall.arguments?.profile || "default"}`} item={browserCall} cwd={browserCall.arguments?.projectPath || thread.cwd} />}</div>
      </main>
      {dialog?.type === "project" && <ProjectDialog initial={cwd || state?.parent || ""} onClose={() => setDialog(null)} onSave={async (value) => { const project = await codexApi.addProject(value); await refresh(); selectThread("", project.cwd); setDialog(null); }} />}
      {dialog?.type === "rename" && <NameDialog initial={threadTitle(thread)} onClose={() => setDialog(null)} onSave={async (name) => { await codexApi.rename(id, name); setDialog(null); refresh(); }} />}
      {dialog?.type === "archive" && <ConfirmDialog title="归档 Codex 会话" message="会话将从列表移除，项目文件不受影响。历史记录保留在 Codex 中。" confirmText="归档" onClose={() => setDialog(null)} onConfirm={async () => { try { await codexApi.archive(id); setExtraThreads((current) => current.filter((entry) => entry.id !== id)); setDialog(null); if (currentId.current === id) selectThread(""); refresh(); } catch (err) { setError(err.message); setDialog(null); } }} />}
      {dialog?.type === "archives" && <ArchivesDialog onClose={() => setDialog(null)} onRestore={async (entry) => { await codexApi.restore(entry.id); await refresh(); setDialog(null); selectThread(entry.id, entry.cwd); }} />}
      {dialog?.type === "revise" && <ReviseDialog action={dialog.action} turn={dialog.turn} onClose={() => setDialog(null)} onSave={async (body) => {
        const source = id;
        const result = await codexApi.revise(source, dialog.turn.id, body);
        setDialog(null); await refresh();
        if (currentId.current === source) {
          if (result.thread.id !== source) selectThread(result.thread.id, result.thread.cwd);
          else setView(result);
          if (result.sendError) setError(`新分支已保留，发送失败：${result.sendError}`);
        }
      }} />}
      {dialog?.type === "queueEdit" && <ReviseDialog action="queue" initial={dialog.entry.text} onClose={() => setDialog(null)} onSave={async ({ text }) => { await codexApi.queue(id, dialog.entry.id, "edit", undefined, text); setDialog(null); }} />}
      {dialog?.type === "help" && <Modal title="Codex 快捷操作" onClose={() => setDialog(null)}><p className="modal-text">输入 / 选择命令，@ 搜索项目文件，$ 选择本地技能。Enter 发送或排队，Shift+Enter 换行；任务运行时 Ctrl/⌘+Enter 立即补充，↑ 恢复历史输入。</p><div className="codex-help">{commandHelp.map(([name, description]) => <div key={name}><code>/{name}</code><span>{description}</span></div>)}</div></Modal>}
      {dialog?.type === "status" && <Modal title="Codex 会话信息" onClose={() => setDialog(null)}><dl className="codex-info"><dt>项目</dt><dd>{thread?.cwd}</dd><dt>会话 ID</dt><dd>{id}</dd><dt>模型</dt><dd>{view.settings.model}</dd><dt>推理强度</dt><dd>{view.settings.effort || "CLI 默认"}</dd><dt>权限</dt><dd>{permissionLabel(view.settings)} · {approvalLabel(view.settings.approvalPolicy)}</dd><dt>轮次</dt><dd>{thread?.turns.length || 0}</dd><dt>累计 token</dt><dd>{tokens(thread?.tokenUsage?.total?.totalTokens || 0)}</dd><dt>最近输入 / 输出</dt><dd>{tokens(thread?.tokenUsage?.last?.inputTokens || 0)} / {tokens(thread?.tokenUsage?.last?.outputTokens || 0)}</dd></dl><p className="faint-line">用量为本次 CLI 连接已报告的数据；未报告时显示 0。</p></Modal>}
      {image && <Modal title="查看图片" wide onClose={() => setImage("")}><img className="codex-image-preview" src={image} alt="Codex 附件" /></Modal>}
    </div>
  );
}

function ArchivesDialog({ onRestore, onClose }) {
  const [entries, setEntries] = useState([]);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState("");
  const [query, setQuery] = useState("");
  const searchRequest = useRef({ query });
  if (searchRequest.current.query !== query) searchRequest.current = { query };
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setEntries([]); setCursor("");
    const timer = setTimeout(() => codexApi.threads("", true, query).then((page) => { if (active) { setEntries(page.threads); setCursor(page.nextCursor); } }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); }), query.trim() ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  return <Modal title="已归档的 Codex 会话" onClose={onClose}><input className="field" aria-label="搜索已归档会话" placeholder="搜索归档标题或历史内容" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="pick-list">{entries.map((entry) => <button className="pick-item" key={entry.id} disabled={Boolean(restoring) || loading} onClick={async () => { setRestoring(entry.id); try { await onRestore(entry); } catch (err) { setError(err.message); } finally { setRestoring(""); } }}><Icon name="undo" /><span className="pick-text"><span className="pick-title">{threadTitle(entry)}</span><span className="pick-hint mono">{entry.cwd}</span>{entry.snippet && <span className="pick-hint">{entry.snippet}</span>}</span><span>{restoring === entry.id ? "恢复中…" : "恢复"}</span></button>)}{loading ? <p className="faint-line"><Spinner /> 加载归档…</p> : !entries.length && <p className="faint-line">{query.trim() ? "没有匹配的归档" : "还没有已归档的会话"}</p>}</div>{error && <p className="error-text">{error}</p>}{cursor && <button className="btn" disabled={loading} onClick={async () => { const request = searchRequest.current; setLoading(true); try { const page = await codexApi.threads(cursor, true, query); if (searchRequest.current !== request) return; setEntries((current) => [...current, ...page.threads]); setCursor(page.nextCursor); } catch (err) { if (searchRequest.current === request) setError(err.message); } finally { if (searchRequest.current === request) setLoading(false); } }}>加载更多归档</button>}</Modal>;
}

function ReviseDialog({ action, turn, initial, onSave, onClose }) {
  const [text, setText] = useState(initial ?? turn?.items.find((item) => item.type === "userMessage")?.content?.find((part) => part.type === "text" && !part.text.startsWith("附件："))?.text ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = action === "edit" || action === "queue";
  const title = { edit: "编辑并在新分支发送", retry: "在新分支重试", revert: "回退到此轮之前", queue: "编辑排队消息" }[action];
  return <Modal title={title} onClose={busy ? () => {} : onClose}><form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await onSave({ action, ...(editable ? { text } : {}) }); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }}>
    <p className="modal-text">{action === "revert" ? "将移除此轮及后续对话记录。此操作不回退项目文件；需要保留记录时，请先分叉会话。" : action === "queue" ? "附件和技能继续保留。保存后队列保持暂停，点击「继续队列」再发送。" : "保留原会话，在此轮之前建立分支并重新发送初始输入，保留附件和技能。项目文件继续使用当前状态。"}</p>
    {editable && <textarea className="field codex-edit-input" aria-label="编辑消息内容" autoFocus value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />}
    {error && <p className="error-text" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy}>{busy ? "处理中…" : action === "revert" ? "确认回退" : action === "queue" ? "保存消息" : "创建分支并发送"}</button></div>
  </form></Modal>;
}

function ProjectDialog({ initial, onSave, onClose }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <Modal title="添加 Codex 项目" onClose={onClose}><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave(value.trim()); } catch (err) { setError(err.message); } finally { setBusy(false); } }}><label className="field-label" htmlFor="codex-project-path">本地项目目录</label><input id="codex-project-path" className="field mono" value={value} autoFocus onChange={(event) => setValue(event.target.value)} /><p className="faint-line">输入已有文件夹的完整路径，也支持 ~/ 开头。</p>{error && <p className="error-text">{error}</p>}<div className="modal-actions"><button type="button" className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !value.trim()}>添加</button></div></form></Modal>;
}

function NameDialog({ initial, onSave, onClose }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <Modal title="重命名 Codex 会话" onClose={onClose}><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave(value.trim()); } catch (err) { setError(err.message); } finally { setBusy(false); } }}><input className="field" aria-label="会话名称" value={value} autoFocus onChange={(event) => setValue(event.target.value)} />{error && <p className="error-text">{error}</p>}<div className="modal-actions"><button type="button" className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !value.trim()}>保存</button></div></form></Modal>;
}
