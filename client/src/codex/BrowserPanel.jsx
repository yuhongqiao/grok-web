import { useEffect, useRef, useState } from "react";
import { browserApi } from "./api.js";
import { Spinner } from "../components/Icon.jsx";

export default function BrowserPanel({ cwd, onAsk }) {
  const [profile, setProfile] = useState("default");
  const [profileName, setProfileName] = useState("default");
  const [profiles, setProfiles] = useState(["default"]);
  const [state, setState] = useState({});
  const [tests, setTests] = useState({ cases: [], reports: [] });
  const [url, setUrl] = useState("http://localhost:3000");
  const [selector, setSelector] = useState("");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [selectedCase, setSelectedCase] = useState(null);
  const [variables, setVariables] = useState({});
  const [report, setReport] = useState(null);
  const [annotating, setAnnotating] = useState(false);
  const [rect, setRect] = useState(null);
  const [note, setNote] = useState("");
  const preview = useRef(null);
  const generation = useRef(0);

  useEffect(() => {
    const version = ++generation.current;
    setState({}); setSelectedCase(null); setReport(null); setRect(null); setError("");
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const [catalog, available] = await Promise.all([browserApi.get("tests", cwd, profile), browserApi.get("profiles", cwd, profile)]);
        const snapshot = catalog.running ? null : await browserApi.get("state", cwd, profile);
        if (generation.current !== version) return;
        setTests(catalog); setProfiles(available.profiles);
        if (snapshot) setState(snapshot);
      } catch (err) { if (generation.current === version) setError(err.message); }
      finally { fetching = false; }
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => { generation.current++; clearInterval(timer); };
  }, [cwd, profile]);

  async function perform(action, body = {}) {
    const version = generation.current;
    setPending(true); setError("");
    try {
      const result = await browserApi.post(action, cwd, profile, body);
      if (generation.current !== version) return;
      if (result.opened !== undefined) { setState(result); setRect(null); }
      else setState(await browserApi.get("state", cwd, profile));
      setTests(await browserApi.get("tests", cwd, profile));
      return result;
    } catch (err) { if (generation.current === version) setError(err.message); }
    finally { if (generation.current === version) setPending(false); }
  }

  const disabled = pending || tests.running;
  const controlled = disabled || state.manual || !state.opened;
  const interactive = disabled || !state.opened;
  const action = (action, values = {}) => perform(state.manual ? "interact" : "action", { action, ...values });
  const target = selector.startsWith("ref:") ? { ref: selector.slice(4) } : { selector };
  const secretNames = [...new Set((selectedCase?.steps || []).flatMap((step) => [...String(step.text || "").matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1])))];

  function point(event) {
    const bounds = preview.current.getBoundingClientRect();
    return { x: Math.round((event.clientX - bounds.left) / bounds.width * state.viewport.width), y: Math.round((event.clientY - bounds.top) / bounds.height * state.viewport.height) };
  }

  async function askWithImage() {
    setPending(true); setError("");
    try {
      const image = new Image(); image.src = `data:image/png;base64,${state.image}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      if (rect) { context.strokeStyle = "#f43f5e"; context.lineWidth = 4; context.strokeRect(rect.x, rect.y, rect.w, rect.h); }
      await onAsk(`请检查浏览器截图${rect ? "中红框标注的位置" : ""}。项目：${cwd}；浏览器配置：${profile}；页面：${state.url}\n${note || "检查界面和交互问题，并通过浏览器工具验证。"}`, [{ name: "browser-annotation.png", mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1] }]);
    } catch (err) { setError(err.message); } finally { setPending(false); }
  }

  return <div className="codex-panel browser-panel" data-testid="codex-browser-panel">
    <div className="panel-toolbar">
      <label>登录配置 <input className="field" list="browser-profiles" aria-label="浏览器登录配置" value={profileName} disabled={disabled} onChange={(event) => setProfileName(event.target.value)} /></label>
      <button className="btn" disabled={disabled || !profileName.trim() || profileName.trim() === profile} onClick={() => setProfile(profileName.trim())}>切换配置</button>
      <datalist id="browser-profiles">{profiles.map((name) => <option key={name}>{name}</option>)}</datalist>
      <button className="btn" disabled={disabled} onClick={() => perform("open")}>打开浏览器</button>
      <button className="btn" disabled={disabled || !state.opened} onClick={() => perform("manual", { manual: !state.manual })}>{state.manual ? "交回 Codex 控制" : "手动接管登录"}</button>
      <button className="btn" disabled={disabled || !state.opened} onClick={() => perform("close")}>关闭浏览器</button>
    </div>
    <p className="faint-line">每个项目和配置独立保存登录态。验证码或授权页面可在下方预览中接管完成。{state.manual && " 当前由你接管，自动操作已暂停；点击页面后填写或键入内容。"}</p>
    <form className="panel-toolbar" onSubmit={(event) => { event.preventDefault(); perform("open", { url }); }}>
      <input className="field mono grow" aria-label="测试页面地址" value={url} onChange={(event) => setUrl(event.target.value)} />
      <button className="btn primary" disabled={disabled || state.manual}>前往</button>
      <button type="button" className="btn" disabled={controlled} onClick={() => action("back")}>后退</button>
      <button type="button" className="btn" disabled={controlled} onClick={() => action("reload")}>刷新</button>
      <button type="button" className="btn" disabled={controlled} onClick={() => action("newTab", { url })}>新标签</button>
      <select className="field" aria-label="测试视口" disabled={controlled} value={`${state.viewport?.width || 1280}x${state.viewport?.height || 800}`} onChange={(event) => { const [width, height] = event.target.value.split("x").map(Number); action("viewport", { width, height }); }}>
        <option value="1280x800">桌面 1280 × 800</option><option value="390x844">手机 390 × 844</option><option value="768x1024">平板 768 × 1024</option>
      </select>
    </form>
    {error && <p className="error-text" role="alert">{error}</p>}
    {(pending || tests.running) && <p className="faint-line"><Spinner /> {tests.running ? "正在回放测试…" : "正在执行…"}</p>}
    {state.opened && <>
      <div className="panel-toolbar browser-tabs">{state.tabs?.map((tab) => <button className={`btn ${tab.active ? "primary" : ""}`} key={tab.index} disabled={interactive} title={tab.url} onClick={() => action("tab", { tab: tab.index })}>{tab.title || `标签 ${tab.index + 1}`}</button>)}<button className="btn" disabled={controlled} onClick={() => action("closeTab")}>关闭当前标签</button></div>
      <div className="panel-toolbar"><span className="mono grow ellipsis" title={state.url}>{state.url}</span><button className="btn" onClick={() => setAnnotating(!annotating)}>{annotating ? "结束标注" : "框选标注"}</button><a className="btn" href={`data:image/png;base64,${state.image}`} download={`browser-${state.viewport?.width}.png`}>保存截图</a></div>
      {state.image && <div className={`browser-preview ${annotating ? "annotating" : ""}`} ref={preview} onPointerDown={(event) => { if (!annotating) return; event.currentTarget.setPointerCapture(event.pointerId); const p = point(event); setRect({ ...p, w: 0, h: 0 }); }} onPointerMove={(event) => { if (annotating && event.buttons && rect) { const p = point(event); setRect({ ...rect, w: p.x - rect.x, h: p.y - rect.y }); } }} onClick={(event) => { if (!annotating && !interactive) action("click", point(event)); }}>
        <img draggable="false" src={`data:image/png;base64,${state.image}`} alt="浏览器实时预览，点击可操作页面" />
        {rect && <svg viewBox={`0 0 ${state.viewport.width} ${state.viewport.height}`}><rect x={Math.min(rect.x, rect.x + rect.w)} y={Math.min(rect.y, rect.y + rect.h)} width={Math.abs(rect.w)} height={Math.abs(rect.h)} fill="none" stroke="#f43f5e" strokeWidth="4" /></svg>}
      </div>}
      <div className="panel-toolbar"><input className="field grow" aria-label="截图问题说明" placeholder="描述截图或标注中的问题" value={note} onChange={(event) => setNote(event.target.value)} /><button className="btn" disabled={disabled} onClick={askWithImage}>发给 Codex 检查</button></div>
      <div className="panel-toolbar">
        <select className="field grow" aria-label="选择页面元素" disabled={interactive} value={selector.startsWith("ref:") ? selector : ""} onChange={(event) => setSelector(event.target.value)}><option value="">选择页面元素</option>{state.elements?.map((entry) => <option key={entry.ref} value={`ref:${entry.ref}`}>{entry.ref}. {entry.tag} {entry.label || entry.type}</option>)}</select>
        <input className="field grow mono" aria-label="元素选择器" placeholder="CSS 选择器或 ref:编号" value={selector} onChange={(event) => setSelector(event.target.value)} />
        <button className="btn" disabled={interactive || !selector} onClick={() => action("click", target)}>点击</button>
      </div>
      <div className="panel-toolbar">
        <input className="field grow" type={state.elements?.find((entry) => `ref:${entry.ref}` === selector || entry.selector === selector)?.type === "password" ? "password" : "text"} aria-label="浏览器输入内容" placeholder="输入内容／断言文字" value={text} onChange={(event) => setText(event.target.value)} autoComplete="off" />
        <button className="btn" disabled={interactive || !selector} onClick={async () => { await action("fill", { ...target, text }); setText(""); }}>填写</button>
        <button className="btn" disabled={interactive} onClick={async () => { await action("type", { text }); setText(""); }}>键入</button>
        <button className="btn" disabled={interactive} onClick={() => action("press", { key: "Enter", ...target })}>Enter</button>
        <button className="btn" disabled={interactive} onClick={() => action("scroll", { y: 600 })}>向下滚动</button>
        <button className="btn" disabled={controlled || !text} onClick={() => action("assert", { text })}>断言文字存在</button>
      </div>
    </>}
    <div className="panel-card"><h3>测试用例</h3><div className="panel-toolbar">
      <button className="btn" disabled={controlled} onClick={() => perform("recording", { action: state.recording ? "cancel" : "start" })}>{state.recording ? "取消录制" : "开始录制"}</button>
      {state.recording && <><input className="field grow" aria-label="测试用例名称" placeholder="用例名称" value={name} onChange={(event) => setName(event.target.value)} /><button className="btn primary" disabled={disabled || !name.trim()} onClick={() => perform("recording", { action: "save", name })}>保存用例</button></>}
    </div><p className="faint-line">记录通过此面板或 Codex 工具执行的操作与断言；手动接管的操作不录制。口令使用运行变量，回放时单独填写。</p>
      {tests.cases.map((entry) => <button className="panel-list-row" key={entry.id} onClick={() => { setSelectedCase(entry); setVariables({}); }}><span>{entry.name}</span><small>{entry.steps.length} 步 · 选择并回放</small></button>)}
      {selectedCase && <div className="panel-card"><strong>{selectedCase.name}</strong>{secretNames.map((key) => <label className="codex-form-field" key={key}>{key}<input className="field" type="password" aria-label={`运行变量 ${key}`} autoComplete="off" value={variables[key] || ""} onChange={(event) => setVariables({ ...variables, [key]: event.target.value })} /></label>)}<button className="btn primary" disabled={disabled || state.manual || state.recording || secretNames.some((key) => !variables[key])} onClick={async () => { const result = await perform(`tests/${selectedCase.id}/run`, { variables }); if (result) setReport(result); setVariables({}); }}>运行测试</button></div>}
    </div>
    <div className="panel-card"><h3>测试报告</h3>{tests.reports.map((entry) => <button className="panel-list-row" key={entry.id} onClick={() => setReport(entry)}><span>{entry.status === "passed" ? "✓" : "✗"} {entry.name}</span><small>{new Date(entry.startedAt).toLocaleString()}</small></button>)}
      {report && <div className="browser-report" data-testid="codex-browser-report"><strong>{report.name} · {report.status === "passed" ? "通过" : "失败"}</strong><div className="panel-toolbar"><a className="btn" href={browserApi.artifact(cwd, profile, report.id)} download="report.json">下载报告</a><button className="btn" disabled={disabled || report.status !== "passed"} onClick={() => perform(`reports/${report.id}/baseline`)}>设为视觉基准</button><button className="btn" disabled={disabled} onClick={() => onAsk(`请根据以下浏览器测试报告修复问题，并通过原生 MCP browser_tests 工具重新运行相同用例确认结果。projectPath=${JSON.stringify(cwd)}，profile=${JSON.stringify(profile)}，caseId=${JSON.stringify(report.caseId)}。如果需要运行密钥，请向我询问。\n${JSON.stringify(report, null, 2)}`).catch((err) => setError(err.message))}>让 Codex 修复并重测</button></div>
        {report.visual && <p>与基准截图差异 {report.visual.percent}%{!report.visual.sameSize && "，截图尺寸已改变"}</p>}{report.error && <p className="error-text">{report.error}</p>}
        {report.steps.map((step) => <details key={step.index}><summary>{step.status === "passed" ? "✓" : "✗"} {step.index + 1}. {step.action} · {step.durationMs}ms {step.error}</summary>{step.screenshot && <img src={browserApi.artifact(cwd, profile, report.id, step.screenshot)} alt={`第 ${step.index + 1} 步截图`} />}</details>)}
        <details><summary>本次测试控制台与网络诊断</summary><pre className="code-box">{JSON.stringify({ console: report.console, network: report.network }, null, 2)}</pre></details>
      </div>}
    </div>
    {state.opened && <details className="panel-card"><summary>当前页面文字、控制台与网络</summary><pre className="code-box">{state.text}</pre><pre className="code-box">{JSON.stringify({ console: state.console, network: state.network }, null, 2)}</pre></details>}
  </div>;
}
