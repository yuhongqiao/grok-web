import { useEffect, useState } from "react";
import { browserApi } from "./api.js";
import { browserLabel } from "./browser.js";
import Icon, { Spinner } from "../components/Icon.jsx";

export default function BrowserSession({ item, cwd }) {
  const profile = item.arguments?.profile || "default";
  const [state, setState] = useState({});
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");

  useEffect(() => { setState({}); setText(""); setError(""); }, [cwd, profile]);
  useEffect(() => { setCollapsed(false); }, [item.id]);
  useEffect(() => {
    let active = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try { const value = await browserApi.get("state", cwd, profile); if (active) { setState(value); setError(""); } }
      catch (err) { if (active) setError(err.message); }
      finally { fetching = false; }
    };
    refresh();
    const timer = setInterval(refresh, 1200);
    return () => { active = false; clearInterval(timer); };
  }, [cwd, profile, item.id, item.status]);

  async function perform(route, body) {
    setPending(true); setError("");
    try {
      const result = await browserApi.post(route, cwd, profile, body);
      setState(result.opened === undefined ? await browserApi.get("state", cwd, profile) : result);
      return true;
    } catch (err) { setError(err.message); return false; }
    finally { setPending(false); }
  }

  const interact = (body) => perform("interact", body);
  return <aside className={`codex-browser-session ${collapsed ? "collapsed" : ""}`} data-testid="codex-browser-session" aria-label="Codex 内置浏览器">
    <div className="browser-session-head"><Icon name="globe" /><strong>内置浏览器</strong><button className="icon-button" aria-label={collapsed ? "展开内置浏览器" : "收起内置浏览器"} onClick={() => setCollapsed(!collapsed)}><Icon name={collapsed ? "chevronDown" : "chevronRight"} /></button></div>
    {!collapsed && <div className="browser-session-body">
      <p className="browser-session-status" role="status">{item.status === "inProgress" && !state.manual && <Spinner />}{state.manual ? "等待你完成登录或验证" : browserLabel(item)}{item.status === "failed" && " · 失败"}</p>
      <div className="browser-session-address" title={state.url}>{state.url || "正在打开浏览器…"}</div>
      {state.image && <img className={`browser-session-image ${state.manual ? "interactive" : ""}`} src={`data:image/png;base64,${state.image}`} alt={state.title || "浏览器实时页面"} draggable="false" tabIndex={state.manual ? 0 : undefined} aria-label={state.manual ? "接管中的浏览器页面，可点击或按键" : "浏览器实时页面"}
        onClick={(event) => {
          if (!state.manual || pending) return;
          event.currentTarget.focus();
          const rect = event.currentTarget.getBoundingClientRect();
          interact({ action: "click", x: Math.round((event.clientX - rect.left) / rect.width * state.viewport.width), y: Math.round((event.clientY - rect.top) / rect.height * state.viewport.height) });
        }}
        onKeyDown={(event) => {
          if (!state.manual || pending || event.ctrlKey || event.metaKey || event.altKey) return;
          if (["Tab", "Enter", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); interact({ action: "press", key: event.key }); }
        }} />}
      {!state.image && <p className="faint-line">{state.opened === false ? "浏览器尚未打开；Codex 调用工具后会显示页面。" : "正在获取页面预览…"}</p>}
      {state.opened && <>
        {state.manual ? <div className="browser-session-takeover">
          <p>{state.handoffReason || "点击预览中的输入框，在下方输入内容，完成登录后交回控制权。"}</p>
          <form onSubmit={async (event) => { event.preventDefault(); if (text && await interact({ action: "type", text })) setText(""); }}>
            <input className="field" type="password" autoComplete="off" aria-label="接管浏览器输入" placeholder="点击页面输入框后，在这里输入" value={text} disabled={pending} onChange={(event) => setText(event.target.value)} />
            <button className="btn" disabled={pending || !text}>输入到页面</button>
          </form>
          <div className="panel-toolbar"><button className="btn" disabled={pending} onClick={() => interact({ action: "press", key: "Tab" })}>Tab</button><button className="btn" disabled={pending} onClick={() => interact({ action: "press", key: "Enter" })}>Enter</button><button className="btn" disabled={pending} onClick={() => interact({ action: "scroll", y: 500 })}>向下滚动</button></div>
          <button className="btn primary" disabled={pending} onClick={async () => { if (await perform("manual", { manual: false })) setText(""); }}>完成登录，继续</button>
        </div> : <button className="btn" disabled={pending || state.running} onClick={() => perform("manual", { manual: true })}>接管浏览器</button>}
        <p className="faint-line">{state.manual ? "接管期间 Codex 的自动操作会暂停。" : "Codex 自动操作此页面，你可以继续在对话中补充要求。"}</p>
        {state.tabs?.length > 1 && <div className="panel-toolbar">{state.tabs.map((entry) => <button className={`btn ${entry.active ? "primary" : ""}`} key={entry.index} disabled={!state.manual || pending} title={entry.url} onClick={() => interact({ action: "tab", tab: entry.index })}>{entry.title || `标签 ${entry.index + 1}`}</button>)}</div>}
        <details><summary>页面诊断</summary><pre className="code-box">{JSON.stringify({ console: state.console?.filter((entry) => entry.type === "error"), network: state.network?.filter((entry) => entry.error || entry.status >= 400) }, null, 2)}</pre></details>
      </>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>}
  </aside>;
}
