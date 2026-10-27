import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { codexApi, workspaceApi } from "./api.js";
import { Spinner } from "../components/Icon.jsx";

export default function WorkspacePanel({ cwd, threadId, busy, onReview, onAsk }) {
  const [tab, setTab] = useState("files");
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState([]);
  const [file, setFile] = useState(null);
  const [saved, setSaved] = useState("");
  const [git, setGit] = useState(null);
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [reviewType, setReviewType] = useState("uncommittedChanges");
  const [reviewValue, setReviewValue] = useState("");
  const [scripts, setScripts] = useState({});
  const [command, setCommand] = useState("");
  const [processes, setProcesses] = useState([]);
  const [selected, setSelected] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [gitRequest, setGitRequest] = useState(null);

  async function run(operation) {
    setPending(true); setError(""); setNotice("");
    try { return await operation(); } catch (err) { setError(err.message); }
    finally { setPending(false); }
  }

  useEffect(() => {
    let active = true;
    workspaceApi.tree(cwd, directory).then((result) => { if (active) setEntries(result.entries); }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [cwd, directory]);

  useEffect(() => {
    let active = true;
    if (tab === "git") workspaceApi.git(cwd).then((result) => { if (active) setGit(result); }).catch((err) => { if (active) setError(err.message); });
    if (tab === "services") workspaceApi.scripts(cwd).then((result) => { if (active) setScripts(result.scripts); }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [cwd, tab]);

  useEffect(() => workspaceApi.watch(cwd, (event) => {
    if (event.type === "snapshot") { setProcesses(event.processes); setError(""); }
    else if (event.type === "process") setProcesses((current) => [...current.filter((entry) => entry.id !== event.process.id), event.process]);
    else if (event.type === "output") setProcesses((current) => current.map((entry) => entry.id === event.id ? { ...entry, output: (entry.output + event.output).slice(-1_000_000) } : entry));
  }, setError), [cwd]);

  async function openFile(path) {
    if (file && file.text !== saved) { setError("当前文件有未保存的修改，请先保存，或点击「重新加载」放弃修改。"); return; }
    await run(async () => { const result = await workspaceApi.read(cwd, path); setFile(result); setSaved(result.text); });
  }

  async function start(kind, command) {
    await run(async () => { const process = await workspaceApi.start(cwd, { kind, command }); setSelected(process.id); setProcesses((current) => [...current.filter((entry) => entry.id !== process.id), process]); });
  }

  const task = processes.find((entry) => entry.id === selected) || processes.filter((entry) => entry.kind === (tab === "terminal" ? "terminal" : "service")).at(-1);
  const gitAction = (action, body) => run(async () => {
    try { setGit(await workspaceApi.gitAction(cwd, action, body)); setDiff(""); setGitRequest(null); }
    catch (error) { setGitRequest({ action, ...body }); throw error; }
  });
  const save = () => run(async () => { const result = await workspaceApi.save(cwd, file); setFile(result); setSaved(result.text); setNotice("文件已保存"); });

  return <div className="codex-panel" data-testid="codex-workspace-panel">
    <div className="panel-toolbar panel-tabs">{[["files", "文件"], ["git", "Git 与审查"], ["terminal", "终端"], ["services", "项目服务"]].map(([key, label]) => <button className={`btn ${tab === key ? "primary" : ""}`} key={key} onClick={() => { setTab(key); setError(""); setSelected(""); }}>{label}</button>)}<span className="mono ellipsis grow" title={cwd}>{cwd}</span></div>
    {error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="faint-line" role="status">{notice}</p>}{pending && <p className="faint-line"><Spinner /> 正在执行 CLI 操作…</p>}
    {tab === "git" && gitRequest && <div className="panel-toolbar"><span className="faint-line grow">直接 Git 操作未成功，可交给 Codex 按原生审批流程处理。</span><button className="btn" disabled={pending || busy || !threadId} onClick={() => run(() => onAsk(`请在项目 ${JSON.stringify(cwd)} 中执行此 Git 操作，遵守当前 CLI 权限和审批策略；只操作列出的文件，不提交其他未暂存内容。请求：${JSON.stringify(gitRequest)}。完成后报告结果。`))}>交给 Codex 处理</button></div>}
    {tab === "files" && <div className="workspace-files">
      <div className="workspace-tree"><div className="panel-toolbar"><button className="btn" disabled={!directory} onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>上一级</button><button className="btn" onClick={() => run(async () => setEntries((await workspaceApi.tree(cwd, directory)).entries))}>刷新</button></div><p className="mono faint-line">/{directory}</p>{entries.map((entry) => <button className="panel-list-row" key={entry.fileName} title={entry.fileName} onClick={() => { const path = [directory, entry.fileName].filter(Boolean).join("/"); entry.isDirectory ? setDirectory(path) : openFile(path); }}><span>{entry.isDirectory ? "▸" : "·"} {entry.fileName}</span></button>)}</div>
      <div className="workspace-editor">{file ? <><div className="panel-toolbar"><strong className="mono grow ellipsis" title={file.path}>{file.path}{file.text !== saved && " *"}</strong><button className="btn" disabled={pending} onClick={() => run(async () => { const result = await workspaceApi.read(cwd, file.path); setFile(result); setSaved(result.text); })}>重新加载</button><button className="btn primary" disabled={pending || file.text === saved} onClick={save}>保存文件</button></div><textarea className="field mono" spellCheck="false" aria-label="项目文件内容" value={file.text} onChange={(event) => setFile({ ...file, text: event.target.value })} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); save(); } }} /><p className="faint-line">Ctrl/⌘+S 保存；文件由 CLI 或其他程序改动时会提示冲突，请先重新加载并合并。</p></> : <p className="faint-line">选择文本文件，通过原生 CLI 文件接口打开和编辑。</p>}</div>
    </div>}
    {tab === "git" && <>
      <div className="panel-toolbar"><strong className="grow">当前分支：{git?.branch || "未命名"}</strong><button className="btn" disabled={pending} onClick={() => run(async () => setGit(await workspaceApi.git(cwd)))}>刷新 Git</button></div>
      {git?.files.map((entry) => <div className="panel-toolbar git-file" key={entry.path}><code>{entry.status}</code><span className="grow mono ellipsis" title={entry.path}>{entry.path}</span><button className="btn" disabled={pending} onClick={() => run(async () => setDiff((await workspaceApi.gitAction(cwd, "diff", { path: entry.path, untracked: entry.status === "??" })).diff))}>工作区差异</button>{entry.status[0] !== " " && entry.status !== "??" && <button className="btn" disabled={pending} onClick={() => run(async () => setDiff((await workspaceApi.gitAction(cwd, "diff", { path: entry.path, staged: true })).diff))}>暂存差异</button>}<button className="btn" disabled={pending} onClick={() => gitAction("stage", { paths: [entry.path, ...(entry.from ? [entry.from] : [])] })}>暂存</button>{entry.status[0] !== " " && entry.status !== "??" && <button className="btn" disabled={pending} onClick={() => gitAction("unstage", { paths: [entry.path, ...(entry.from ? [entry.from] : [])] })}>取消暂存</button>}</div>)}
      {git && !git.files.length && <p className="faint-line">工作区没有修改。</p>}{diff && <pre className="code-box workspace-diff">{diff}</pre>}
      <form className="panel-toolbar" onSubmit={(event) => { event.preventDefault(); gitAction("commit", { message }); }}><input className="field grow" aria-label="Git 提交说明" placeholder="提交说明（只提交已暂存内容）" value={message} onChange={(event) => setMessage(event.target.value)} /><button className="btn" disabled={pending || !message.trim() || !git?.files.some((entry) => entry.status[0] !== " " && entry.status !== "??")}>提交暂存内容</button></form>
      <form className="panel-toolbar" onSubmit={(event) => { event.preventDefault(); gitAction("branch", { name: branch }); }}><input className="field grow" aria-label="新 Git 分支名称" placeholder="新分支名称" value={branch} onChange={(event) => setBranch(event.target.value)} /><button className="btn" disabled={pending || !branch.trim()}>创建并切换分支</button></form>
      <div className="panel-card"><h3>原生 Codex 代码审查</h3><div className="panel-toolbar"><select className="field" aria-label="代码审查范围" value={reviewType} onChange={(event) => { setReviewType(event.target.value); setReviewValue(""); }}><option value="uncommittedChanges">未提交修改</option><option value="baseBranch">与基础分支比较</option><option value="commit">指定提交</option><option value="custom">自定义审查要求</option></select>{reviewType !== "uncommittedChanges" && <input className="field grow" aria-label="代码审查目标" placeholder={reviewType === "baseBranch" ? "基础分支，如 main" : reviewType === "commit" ? "提交 SHA" : "审查要求"} value={reviewValue} onChange={(event) => setReviewValue(event.target.value)} />}<button className="btn primary" disabled={pending || busy || !threadId || (reviewType !== "uncommittedChanges" && !reviewValue.trim())} onClick={() => run(async () => { const key = { baseBranch: "branch", commit: "sha", custom: "instructions" }[reviewType]; await codexApi.review(threadId, { type: reviewType, ...(key ? { [key]: reviewValue } : {}) }); onReview(); })}>开始审查</button></div><p className="faint-line">通过 CLI 的 review/start 执行，结果显示在当前会话中。</p></div>
    </>}
    {(tab === "terminal" || tab === "services") && <>
      <div className="panel-toolbar">{tab === "terminal" ? <button className="btn primary" disabled={pending} onClick={() => start("terminal")}>新建终端</button> : <><select className="field grow" aria-label="项目启动脚本" value="" onChange={(event) => setCommand(`npm run ${event.target.value}`)}><option value="">选择 package.json 脚本</option>{Object.entries(scripts).map(([name, script]) => <option key={name} value={name}>{name}: {script}</option>)}</select><input className="field grow mono" aria-label="项目服务命令" placeholder="例如 npm run dev" value={command} onChange={(event) => setCommand(event.target.value)} /><button className="btn primary" disabled={pending || !command.trim()} onClick={() => start("service", command)}>启动服务</button></>}</div>
      <div className="panel-toolbar">{processes.filter((entry) => entry.kind === (tab === "terminal" ? "terminal" : "service")).map((entry, index) => <button className={`btn ${task?.id === entry.id ? "primary" : ""}`} key={entry.id} onClick={() => setSelected(entry.id)}>{tab === "terminal" ? `终端 ${index + 1}` : entry.command.slice(0, 40)} · {entry.running ? "运行中" : `已退出 ${entry.exitCode ?? ""}`}</button>)}</div>
      {task && <><div className="panel-toolbar"><span className="mono grow ellipsis">{task.command}</span><button className="btn" disabled={pending || !task.running} onClick={() => run(() => workspaceApi.process(cwd, task.id, "stop"))}>停止进程</button></div>{task.error && <p className="error-text">{task.error}</p>}{task.kind === "terminal" ? <NativeTerminal key={task.id} cwd={cwd} task={task} onError={setError} /> : <pre className="code-box service-output">{task.output || "等待输出…"}</pre>}</>}
      <p className="faint-line">使用 CLI 原生 command/exec，沿用其权限配置。切换面板后进程继续运行，可在此停止。</p>
    </>}
  </div>;
}

function NativeTerminal({ cwd, task, onError }) {
  const container = useRef(null);
  const terminal = useRef(null);
  const output = useRef("");
  const running = useRef(task.running); running.current = task.running;
  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 3000, theme: { background: "#101114", foreground: "#eeeeee" } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current); terminal.current = term;
    let writes = Promise.resolve();
    const input = term.onData((text) => { if (running.current) writes = writes.then(() => workspaceApi.process(cwd, task.id, "write", { text })).catch((err) => onError(err.message)); });
    const resize = new ResizeObserver(() => { fit.fit(); if (running.current) workspaceApi.process(cwd, task.id, "resize", { cols: term.cols, rows: term.rows }).catch(() => {}); });
    resize.observe(container.current);
    return () => { resize.disconnect(); input.dispose(); term.dispose(); terminal.current = null; };
  }, [cwd, task.id]);
  useEffect(() => {
    if (!terminal.current) return;
    if (task.output.startsWith(output.current)) terminal.current.write(task.output.slice(output.current.length));
    else { terminal.current.reset(); terminal.current.write(task.output); }
    output.current = task.output;
  }, [task.output]);
  return <div className="native-terminal" ref={container} data-testid="codex-native-terminal" />;
}
