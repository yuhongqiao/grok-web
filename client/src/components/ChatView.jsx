import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MODES, money, shortPath, tokens } from "../format.js";
import { PermissionCard, PlanCard, QuestionCard } from "./Cards.jsx";
import Composer from "./Composer.jsx";
import Icon, { Spinner } from "./Icon.jsx";
import { LogoMark } from "./Logo.jsx";
import { AssistantMessage, Dots, Note, ToolRow, UserMessage } from "./Message.jsx";

const PAGE = 80;

export default function ChatView({
  selection,
  view,
  project,
  sessionTitle,
  settings,
  models,
  catalog,
  sessions,
  pending,
  prefs,
  error,
  seed,
  onDismissError,
  onSubmit,
  onStop,
  onSettings,
  onQueue,
  onAnswer,
  onRejectWith,
  onRename,
  onAction,
  onPickProject,
  onShowList,
  onImage,
}) {
  const [tab, setTab] = useState("chat");
  const [limit, setLimit] = useState(PAGE);
  const scroller = useRef(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const state = view.state;
  const isDraft = selection?.kind === "draft";
  const running = Boolean(state?.running);
  const messages = useMemo(() => {
    const list = view.messages;
    return pending ? [...list, { role: "user", text: pending.text, images: pending.images, files: pending.files, pending: true }] : list;
  }, [view.messages, pending]);
  const shown = messages.length > limit ? messages.slice(messages.length - limit) : messages;
  const cwd = project?.cwd || state?.cwd || "";
  const mode = settings.mode;
  // Stable across renders so finished messages are not re-rendered on every streamed chunk.
  const latest = useRef({ messages, onAction });
  latest.current = { messages, onAction };
  const footerAction = useCallback((action, target, index) => {
    latest.current.onAction(action, { message: target, index, messages: latest.current.messages });
  }, []);

  useEffect(() => {
    setTab("chat");
    setLimit(PAGE);
    stick.current = true;
  }, [selection?.id, selection?.encoded, selection?.kind]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages, state?.interactions?.length, tab, pending]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
    stick.current = near;
    setAway(!near);
  };

  const toBottom = () => {
    const element = scroller.current;
    if (!element) return;
    stick.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const lastIndex = messages.length - 1;
  const liveIndex = running ? lastIndex : -1;
  const toolFor = (toolCallId) => {
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - 4); index -= 1) {
      const found = messages[index].blocks?.find((block) => block.type === "tool" && block.id === toolCallId);
      if (found) return found;
    }
    return null;
  };
  const interactions = state?.interactions || [];
  const modeInfo = MODES[mode] || MODES.ask;

  return (
    <main className="main">
      <header className="chat-head">
        <button type="button" className="icon-button only-mobile" aria-label="会话列表" onClick={onShowList}>
          <Icon name="sidebar" size={18} />
        </button>
        <Title title={isDraft ? "新会话" : sessionTitle || state?.title || "会话"} editable={!isDraft} onRename={onRename} />
        <span className="mode-tag" title={modeInfo.hint}><Icon name={modeInfo.icon} size={13} />{modeInfo.label}</span>
        {project && <span className="head-project" title={project.cwd}><Icon name="folder" size={13} />{project.name}</span>}
        <span className="spacer" />
        {!isDraft && (
          <HeaderMenu onAction={onAction} />
        )}
      </header>
      <nav className="tabs">
        <button type="button" className={tab === "chat" ? "tab active" : "tab"} onClick={() => setTab("chat")}>对话</button>
        <button type="button" className={tab === "trace" ? "tab active" : "tab"} data-testid="trace-tab" onClick={() => setTab("trace")}>轨迹</button>
      </nav>
      {error && (
        <div className="banner bad" data-testid="error">
          <Icon name="alert" size={15} />
          <span>{error}</span>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onDismissError}><Icon name="x" size={14} /></button>
        </div>
      )}
      {state?.retry && !state.retry.exhausted && (
        <div className="banner warn" title={state.retry.reason}>
          <Spinner size={14} />
          <span>模型繁忙，正在第 {state.retry.attempt}{state.retry.max ? `/${state.retry.max}` : ""} 次重试…</span>
        </div>
      )}
      {state?.retry?.exhausted && (
        <div className="banner bad"><Icon name="alert" size={15} /><span>{state.retry.rateLimited ? "用量到上限了：" : "重试都失败了："}{state.retry.reason}</span></div>
      )}
      {state?.elsewhere > 0 && (
        <div className="banner info">
          <Icon name="terminal" size={15} />
          <span>这个会话还在终端里开着（进程 {state.elsewhere}）。网页和终端各记各的，同时发消息会互相看不到。</span>
        </div>
      )}
      <div className="scroller" ref={scroller} onScroll={onScroll} data-testid="transcript">
        <div className="column">
          {tab === "trace" ? <Trace messages={messages} cwd={cwd} /> : (
            <>
              {!isDraft && !view.ready && <div className="loading"><Spinner size={18} /></div>}
              {isDraft && !messages.length && <Welcome project={project} />}
              {view.truncated && <p className="faint-line">会话很长，只读了最后一段。</p>}
              {messages.length > limit && (
                <button type="button" className="more-button" onClick={() => setLimit(limit + PAGE)}>显示更早的 {Math.min(PAGE, messages.length - limit)} 条</button>
              )}
              {shown.map((message, index) => {
                const at = messages.length - shown.length + index;
                if (message.role === "user") return <UserMessage key={at} message={message} onImage={onImage} />;
                if (message.role === "note") return <Note key={at} message={message} />;
                return (
                  <AssistantMessage
                    key={at}
                    message={message}
                    index={at}
                    live={at === liveIndex}
                    cwd={cwd}
                    thinkingOpen={prefs.thinkingOpen}
                    onAction={footerAction}
                  />
                );
              })}
              {(running || pending) && messages.at(-1)?.role !== "assistant" && <div className="msg assistant"><Dots /></div>}
            </>
          )}
        </div>
      </div>
      {away && (
        <button type="button" className="to-bottom" aria-label="回到底部" onClick={toBottom}><Icon name="arrowDown" size={16} /></button>
      )}
      <div className="dock">
        <div className="column">
          {interactions.map((interaction) => {
            if (interaction.kind === "permission") {
              return (
                <PermissionCard
                  key={interaction.requestId}
                  interaction={interaction}
                  tool={toolFor(interaction.toolCallId)}
                  cwd={cwd}
                  onAnswer={(body) => onAnswer(interaction.requestId, body)}
                  onRejectWith={(optionId, text) => onRejectWith(interaction.requestId, optionId, text)}
                />
              );
            }
            if (interaction.kind === "question") return <QuestionCard key={interaction.requestId} interaction={interaction} onAnswer={(body) => onAnswer(interaction.requestId, body)} />;
            return <PlanCard key={interaction.requestId} interaction={interaction} onAnswer={(body) => onAnswer(interaction.requestId, body)} />;
          })}
          <Composer
            key={selection?.kind === "session" ? selection.id : `draft-${selection?.encoded || ""}`}
            catalog={catalog}
            sessions={sessions}
            running={running}
            queue={state?.queue || []}
            busy={Boolean(pending)}
            encoded={project?.encoded}
            draftProject={isDraft ? project : null}
            onPickProject={onPickProject}
            model={settings.model}
            effort={settings.effort}
            models={models}
            efforts={settings.efforts}
            mode={mode}
            onSubmit={onSubmit}
            onStop={onStop}
            onSettings={onSettings}
            onQueue={onQueue}
            multiline={prefs.multiline}
            history={messages.filter((message) => message.role === "user" && message.text).map((message) => message.text).slice(-50)}
            seed={seed}
          />
          <StatusLine state={state} />
        </div>
      </div>
    </main>
  );
}

function Title({ title, editable, onRename }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  if (!editable) return <h1 className="chat-title">{title}</h1>;
  if (!editing) {
    return <h1 className="chat-title editable" data-testid="title" title="点击改名" onClick={() => setEditing(true)}>{title}</h1>;
  }
  const done = () => {
    setEditing(false);
    if (value.trim() && value.trim() !== title) onRename(value.trim());
  };
  return (
    <input
      className="title-input"
      data-testid="title-input"
      value={value}
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onBlur={done}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setValue(title);
          setEditing(false);
        }
      }}
    />
  );
}

function HeaderMenu({ onAction }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!box.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const item = (action, icon, label, danger = false) => (
    <button
      type="button"
      className={`menu-item ${danger ? "danger" : ""}`}
      data-testid={`menu-${action}`}
      onClick={() => {
        setOpen(false);
        onAction(action);
      }}
    >
      <Icon name={icon} size={15} />
      <span className="menu-title">{label}</span>
    </button>
  );
  return (
    <div className="popover" ref={box}>
      <button type="button" className="icon-button" data-testid="session-menu" aria-label="会话操作" onClick={() => setOpen(!open)}>
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div className="menu down right">
          {item("rename", "pencil", "重命名")}
          {item("fork", "fork", "分叉")}
          {item("rewind", "undo", "回退到之前的一轮")}
          {item("view-plan", "map", "查看计划")}
          {item("extensions", "box", "技能、MCP 和插件")}
          {item("export", "download", "导出 Markdown")}
          {item("delete", "trash", "删除会话", true)}
        </div>
      )}
    </div>
  );
}

function Welcome({ project }) {
  return (
    <div className="welcome">
      <LogoMark size={60} className="welcome-logo" />
      <h2>有什么可以帮你？</h2>
      {project ? (
        <p>在 <strong>{project.name}</strong> 里新开会话 · <span className="mono">{shortPath(project.cwd)}</span></p>
      ) : <p>先在左边选一个项目，或者新建一个。</p>}
    </div>
  );
}

function Trace({ messages, cwd }) {
  const turns = [];
  let current = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = { prompt: message.text || "（附件）", tools: [] };
      turns.push(current);
    } else if (message.role === "assistant") {
      if (!current) {
        current = { prompt: "", tools: [] };
        turns.push(current);
      }
      current.tools.push(...message.blocks.filter((block) => block.type === "tool"));
    }
  }
  const withTools = turns.filter((turn) => turn.tools.length);
  if (!withTools.length) return <p className="faint-line">这个会话还没有调用过工具。</p>;
  return (
    <div className="trace">
      {withTools.map((turn, index) => (
        <section key={index} className="trace-turn">
          <div className="trace-prompt">{turn.prompt.slice(0, 120) || "（Grok 自己继续）"}</div>
          {turn.tools.map((tool) => <ToolRow key={tool.id} tool={tool} cwd={cwd} nested />)}
        </section>
      ))}
    </div>
  );
}

function StatusLine({ state }) {
  const usage = state?.usage;
  const last = state?.lastTurn?.usage;
  const tasks = state?.tasks || [];
  if (!usage?.total && !tasks.length) return <div className="status-line" />;
  const hit = usage?.input ? Math.round((usage.cached / usage.input) * 100) : 0;
  const speed = last?.apiMs && last.output ? Math.round(last.output / (last.apiMs / 1000)) : 0;
  return (
    <div className="status-line" data-testid="status-line">
      <div>
        {usage?.turns > 0 && <span><Icon name="refresh" size={12} />{usage.turns} 轮{usage.calls ? ` ${usage.calls} 步` : ""}</span>}
        {speed > 0 && <span>{speed} tok/s</span>}
        {usage?.total > 0 && <span><Icon name="database" size={12} />{tokens(usage.total)} tok{hit ? ` · 缓存命中 ${hit}%` : ""}</span>}
        {tasks.length > 0 && <span title={tasks.map((task) => task.command).join("\n")}><Icon name="terminal" size={12} />后台任务 {tasks.length}</span>}
      </div>
      {usage?.total > 0 && (
        <div className="faint">本会话 {money(usage.cost)} · 输入 {tokens(usage.input)} · 缓存 {tokens(usage.cached)} · 输出 {tokens(usage.output)}</div>
      )}
    </div>
  );
}
