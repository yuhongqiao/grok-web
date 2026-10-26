import { useEffect, useState } from "react";
import { api } from "../api.js";
import { MODES, shortPath, stamp } from "../format.js";
import Icon, { Spinner } from "./Icon.jsx";
import { Markdown } from "./Message.jsx";

export function Modal({ title, onClose, children, wide = false, testId }) {
  useEffect(() => {
    const escape = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className={`modal ${wide ? "wide" : ""}`} data-testid={testId} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ProjectDialog({ parent, onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState(parent || "");
  const [manual, setManual] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    try {
      await onCreate({ name: name.trim(), cwd: cwd.trim() });
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Modal title="新建项目" onClose={onCancel} testId="project-dialog">
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="project-name">名称</label>
        <input
          id="project-name"
          className="field"
          data-testid="project-name"
          value={name}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
            if (!manual) setCwd(`${String(parent).replace(/\/$/, "")}/${event.target.value.trim()}`);
          }}
        />
        <label className="field-label" htmlFor="project-path">目录（不存在会自动创建）</label>
        <input
          id="project-path"
          className="field mono"
          data-testid="project-path"
          value={cwd}
          onChange={(event) => {
            setManual(true);
            setCwd(event.target.value);
          }}
        />
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>取消</button>
          <button type="submit" className="btn primary" data-testid="create-project" disabled={!name.trim()}>创建</button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectPicker({ projects, current, onPick, onNewProject, onClose }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const list = projects.filter((project) => !needle || project.name.toLowerCase().includes(needle) || project.cwd.toLowerCase().includes(needle));
  return (
    <Modal title="在哪个项目里开会话？" onClose={onClose} testId="project-picker">
      <input className="field" placeholder="搜索项目" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />
      <div className="pick-list">
        {list.map((project) => (
          <button
            key={project.encoded}
            type="button"
            className={`pick-item ${project.encoded === current ? "selected" : ""}`}
            data-testid="pick-project"
            data-project-name={project.name}
            onClick={() => onPick(project)}
          >
            <Icon name="folder" size={16} />
            <span className="pick-text">
              <span className="pick-title">{project.name}</span>
              <span className="pick-hint mono">{shortPath(project.cwd)}</span>
            </span>
            <span className="pick-count">{project.sessions.length ? `${project.sessions.length} 个会话` : "新项目"}</span>
          </button>
        ))}
        {!list.length && <p className="faint-line">没有匹配的项目</p>}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onNewProject}><Icon name="folderPlus" size={15} />新建项目</button>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({ title = "确认", message, confirmText = "确认", danger = false, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} testId="confirm">
      <p className="modal-text">{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button
          type="button"
          className={`btn ${danger ? "danger" : "primary"}`}
          data-testid="confirm-yes"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}

// Pick a turn of the session: rewind to it, or fork with everything up to it.
export function TurnDialog({ sessionId, purpose, preferText, onDone, onClose }) {
  const [turns, setTurns] = useState(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(null);
  const [scope, setScope] = useState("all");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.turns(sessionId).then((result) => {
      const list = [...result.turns].reverse();
      setTurns(list);
      const preferred = preferText ? list.find((turn) => preferText.startsWith(turn.preview.replace(/\.\.\.$/, ""))) : null;
      setChosen((preferred || list[0])?.index ?? null);
    }, (err) => setError(err.message));
  }, [sessionId, preferText]);
  const rewind = purpose === "rewind";
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await onDone(rewind ? { promptIndex: chosen, scope } : { promptIndex: chosen });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={rewind ? "回退到哪一轮？" : "从哪一轮分叉？"} onClose={onClose} testId="turn-dialog">
      <p className="modal-text faint">
        {rewind
          ? "这一轮和之后的对话会被撤掉，这一轮的提问会放回输入框，方便改了再发。"
          : "新会话会带上从开头到这一轮（含）的对话，原会话不动。"}
      </p>
      {!turns && !error && <div className="loading"><Spinner size={18} /></div>}
      {turns && !turns.length && <p className="faint-line">还没有可以选的轮次</p>}
      <div className="pick-list">
        {turns?.map((turn) => (
          <button
            key={turn.index}
            type="button"
            className={`pick-item ${chosen === turn.index ? "selected" : ""}`}
            data-testid="turn"
            onClick={() => setChosen(turn.index)}
          >
            <span className="turn-index">#{turn.index + 1}</span>
            <span className="pick-text">
              <span className="pick-title">{turn.preview || "（附件）"}</span>
              <span className="pick-hint">{stamp(new Date(turn.createdAt).getTime())}{turn.fileChanges ? ` · 改过 ${turn.files} 个文件` : ""}</span>
            </span>
          </button>
        ))}
      </div>
      {rewind && (
        <div className="segmented">
          <button type="button" className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>对话和文件一起回退</button>
          <button type="button" className={scope === "conversation" ? "on" : ""} onClick={() => setScope("conversation")}>只回退对话</button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className={`btn ${rewind ? "danger" : "primary"}`} data-testid="turn-confirm" disabled={chosen == null || busy} onClick={confirm}>
          {rewind ? "回退" : "分叉"}
        </button>
      </div>
    </Modal>
  );
}

const EXTENSION_TABS = [
  ["skills", "技能"],
  ["mcp", "MCP"],
  ["plugins", "插件"],
  ["hooks", "钩子"],
  ["memory", "记忆"],
];

export function ExtensionsDialog({ initial = "skills", sessionId, encoded, onClose }) {
  const [tab, setTab] = useState(initial);
  const [data, setData] = useState(null);
  useEffect(() => {
    setData(null);
    const params = {};
    if (sessionId) params.session = sessionId;
    if (encoded) params.project = encoded;
    api.extensions(tab, params).then(setData, (err) => setData({ items: [], note: err.message }));
  }, [tab, sessionId, encoded]);
  return (
    <Modal title="技能与扩展" onClose={onClose} wide testId="extensions">
      <div className="segmented">
        {EXTENSION_TABS.map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {!data && <div className="loading"><Spinner size={18} /></div>}
      {data?.note && <p className="faint-line">{data.note}</p>}
      {data && !data.items.length && !data.note && <p className="faint-line">没有内容</p>}
      <div className="pick-list tall">
        {data?.items.map((item) => (
          <div key={`${item.name}-${item.detail}`} className="pick-item static">
            <span className="pick-text">
              <span className="pick-title">{item.name}{!item.enabled && <span className="badge">已停用</span>}</span>
              {item.description && <span className="pick-hint">{item.description}</span>}
            </span>
            {item.detail && <span className="pick-count">{item.detail}</span>}
          </div>
        ))}
      </div>
      {tab === "skills" && <p className="faint-line">技能可以直接当命令用：在输入框打 / 加技能名。</p>}
    </Modal>
  );
}

export function PlanDialog({ sessionId, onClose }) {
  const [content, setContent] = useState(null);
  useEffect(() => {
    api.plan(sessionId).then((result) => setContent(result.content), (err) => setContent(`读取失败：${err.message}`));
  }, [sessionId]);
  return (
    <Modal title="当前计划" onClose={onClose} wide testId="plan-dialog">
      {content == null ? <div className="loading"><Spinner size={18} /></div> : content ? <div className="plan-preview"><Markdown text={content} /></div> : <p className="faint-line">这个会话还没有计划。输入 /plan 进入计划模式。</p>}
    </Modal>
  );
}

export function SettingsDialog({ prefs, onChange, onClose }) {
  const row = (label, hint, control) => (
    <div className="setting">
      <div className="setting-text"><div className="setting-label">{label}</div>{hint && <div className="setting-hint">{hint}</div>}</div>
      {control}
    </div>
  );
  const toggle = (key) => (
    <button type="button" className={`switch ${prefs[key] ? "on" : ""}`} role="switch" aria-checked={Boolean(prefs[key])} onClick={() => onChange({ [key]: !prefs[key] })}>
      <span />
    </button>
  );
  return (
    <Modal title="设置" onClose={onClose} testId="settings">
      {row("外观", "", (
        <div className="segmented small">
          <button type="button" className={prefs.theme !== "light" ? "on" : ""} onClick={() => onChange({ theme: "dark" })}><Icon name="moon" size={14} />深色</button>
          <button type="button" className={prefs.theme === "light" ? "on" : ""} onClick={() => onChange({ theme: "light" })}><Icon name="sun" size={14} />浅色</button>
        </div>
      ))}
      {row("新会话的权限", "已有会话在输入框下方单独切换", (
        <select className="field small" value={prefs.permission || ""} onChange={(event) => onChange({ permission: event.target.value })}>
          <option value="">跟随 Grok 配置</option>
          {["ask", "auto", "yolo"].map((key) => <option key={key} value={key}>{MODES[key].label}</option>)}
        </select>
      ))}
      {row("多行输入", "开启后 Enter 换行，Shift+Enter 发送", toggle("multiline"))}
      {row("展开思考过程", "默认展开 Grok 的思考内容", toggle("thinkingOpen"))}
      <div className="setting-foot faint">
        快捷键：Enter 发送 · Shift+Enter 换行 · 运行中 Ctrl+Enter 立即发送 · Shift+Tab 切换模式 · ↑ 翻历史
      </div>
    </Modal>
  );
}

export function ImageDialog({ image, onClose }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <img className="image-full" alt="" src={`data:${image.mimeType};base64,${image.data}`} />
    </div>
  );
}
