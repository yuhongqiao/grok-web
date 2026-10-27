import { useEffect, useRef, useState } from "react";
import { ago } from "../format.js";
import Icon, { Spinner } from "./Icon.jsx";
import { LogoMark, Wordmark } from "./Logo.jsx";
import WorkspaceSwitch from "./WorkspaceSwitch.jsx";

const SHOWN = 8;

export default function Sidebar({
  state,
  selection,
  expanded,
  onToggleProject,
  onOpenSession,
  onNewSession,
  onNewSessionIn,
  onNewProject,
  onRemoveProject,
  onRenameSession,
  onDeleteSession,
  onSettings,
  onCollapse,
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [more, setMore] = useState(() => new Set());
  const search = useRef(null);
  useEffect(() => {
    if (searching) search.current?.focus();
  }, [searching]);

  const needle = query.trim().toLowerCase();
  const live = state?.live || {};
  const projects = (state?.projects || [])
    .map((project) => {
      if (!needle || project.name.toLowerCase().includes(needle)) return project;
      return { ...project, sessions: project.sessions.filter((session) => session.title.toLowerCase().includes(needle)) };
    })
    .filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.sessions.length);

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand" title="grok web">
          <LogoMark size={30} busy={Object.values(live).some((item) => item.running)} />
          <Wordmark height={23} />
          <span className="brand-badge">web</span>
        </div>
        <button type="button" className="icon-button only-desktop" aria-label="收起边栏" onClick={onCollapse}>
          <Icon name="sidebar" size={17} />
        </button>
      </div>
      <WorkspaceSwitch active="grok" />
      <button type="button" className="new-chat" data-testid="new-chat" onClick={onNewSession}>
        <Icon name="plusCircle" size={17} />
        新会话
      </button>
      <div className="section-head">
        <span className="section-label">工作区</span>
        <span className="spacer" />
        <button type="button" className={`icon-button ${searching ? "on" : ""}`} aria-label="搜索" onClick={() => {
          setSearching(!searching);
          if (searching) setQuery("");
        }}>
          <Icon name="search" size={15} />
        </button>
        <button type="button" className="icon-button" data-testid="new-project" aria-label="新建项目" onClick={onNewProject}>
          <Icon name="folderPlus" size={15} />
        </button>
      </div>
      {searching && (
        <input
          ref={search}
          className="side-search"
          data-testid="side-search"
          placeholder="搜索项目或会话"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
              setSearching(false);
            }
          }}
        />
      )}
      <div className="side-scroll">
        {!state && <div className="side-empty"><Spinner size={16} /></div>}
        {state && !projects.length && <div className="side-empty">{needle ? "没有匹配的项目或会话" : "还没有项目，点上面的 + 新建"}</div>}
        {projects.map((project) => {
          const open = expanded.has(project.encoded) || Boolean(needle);
          const showAll = more.has(project.encoded) || Boolean(needle);
          const list = showAll ? project.sessions : project.sessions.slice(0, SHOWN);
          const busy = project.sessions.some((session) => live[session.id]);
          return (
            <div className="project" key={project.encoded}>
              <div className="project-line">
                <button
                  type="button"
                  className="project-row"
                  data-testid="project"
                  data-project-name={project.name}
                  title={project.cwd}
                  onClick={() => onToggleProject(project.encoded)}
                >
                  <Icon name={open ? "folderOpen" : "folder"} size={16} className="folder" />
                  <span className="project-name">{project.name}</span>
                  {!open && busy && <Spinner size={12} />}
                </button>
                <button type="button" className="row-action" data-testid="new-session" data-project-name={project.name} title="在这个项目里新开会话" onClick={() => onNewSessionIn(project)}>
                  <Icon name="plus" size={15} />
                </button>
                <button type="button" className="row-action" title="从列表移除（不删除代码）" onClick={() => onRemoveProject(project)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
              {open && (
                <div className="sessions">
                  {project.sessions.length === 0 && <div className="session-empty">还没有会话</div>}
                  {list.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      live={live[session.id]}
                      current={selection?.kind === "session" && selection.id === session.id}
                      onOpen={() => onOpenSession(project, session)}
                      onRename={(title) => onRenameSession(session, title)}
                      onDelete={() => onDeleteSession(session)}
                    />
                  ))}
                  {project.sessions.length > list.length && (
                    <button type="button" className="session-more" onClick={() => setMore((current) => new Set(current).add(project.encoded))}>
                      显示全部 {project.sessions.length} 个会话
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="side-foot">
        <button type="button" className="foot-button" data-testid="open-settings" onClick={onSettings}>
          <Icon name="settings" size={16} />
          设置
        </button>
      </div>
    </aside>
  );
}

function SessionRow({ session, live, current, onOpen, onRename, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(session.title);
  useEffect(() => setValue(session.title), [session.title]);
  if (editing) {
    const done = () => {
      setEditing(false);
      if (value.trim() && value.trim() !== session.title) onRename(value.trim());
    };
    return (
      <input
        className="session-edit"
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onBlur={done}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setValue(session.title);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <div className={`session-line ${current ? "current" : ""}`}>
      <button type="button" className="session-row" data-testid="session" data-session-id={session.id} title={session.title} onClick={onOpen} onDoubleClick={() => setEditing(true)}>
        <span className="session-title">{session.title}</span>
        {live?.waiting ? <span className="dot warn" title="等你确认" /> : live?.running ? <Spinner size={12} /> : <span className="session-age">{ago(session.updatedAt)}</span>}
      </button>
      <span className="session-actions">
        <button type="button" className="row-action" title="改名" onClick={() => setEditing(true)}><Icon name="pencil" size={13} /></button>
        <button type="button" className="row-action" title="删除" data-testid="delete-session" onClick={onDelete}><Icon name="trash" size={13} /></button>
      </span>
    </div>
  );
}
