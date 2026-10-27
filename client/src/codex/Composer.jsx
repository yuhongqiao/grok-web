import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon, { Spinner } from "../components/Icon.jsx";
import { effortLabel } from "../format.js";
import { codexApi } from "./api.js";
import { draftKey, loadAttachments, saveAttachments } from "./drafts.js";
import { Modal } from "../components/Dialogs.jsx";
import { sandboxLabels, approvalLabels, granularFields, profileLabel, approvalLabel, permissionLabel, permissionPresets } from "./permissions.js";

const COMMANDS = [
  ["new", "新会话"], ["resume", "搜索会话"], ["rename", "重命名会话"], ["fork", "从当前会话分叉"],
  ["compact", "压缩上下文"], ["plan", "切换计划 / 执行模式"], ["model", "选择模型"], ["effort", "选择推理强度"],
  ["skills", "选择本地技能"], ["status", "查看会话信息"], ["copy", "复制最新回复"], ["export", "导出 Markdown"], ["archive", "归档会话"], ["help", "查看快捷操作"],
  ["settings", "保存当前会话设置"], ["skill-manager", "刷新或启停本地技能"],
  ["retry", "在新分支重试最近输入"], ["undo", "回退最近一轮会话记录"],
  ["review", "审查未提交修改"], ["link", "复制会话链接"], ["resume-cli", "复制 CLI 恢复命令"],
  ["browser", "浏览器测试面板"], ["workspace", "文件、Git、终端与服务"],
];

export default function CodexComposer({ storageKey, ready, busy, submitting, turnId, canStop, models, collaborationModes, settings, projects, cwd, isNew, onProject, onAddProject, onSubmit, onStop, onCommand }) {
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey(storageKey)) || "");
  const [options, setOptions] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(`${draftKey(storageKey)}:options`) || "{}"); } catch { return {}; }
  });
  const [attachments, setAttachments] = useState([]);
  const [filesReady, setFilesReady] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [index, setIndex] = useState(0);
  const [fileResults, setFileResults] = useState([]);
  const [skillCatalog, setSkillCatalog] = useState(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [manageSkills, setManageSkills] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [permissionCatalog, setPermissionCatalog] = useState(null);
  const [permissionError, setPermissionError] = useState("");
  const [showPermissions, setShowPermissions] = useState(false);
  const box = useRef(null);
  const picker = useRef(null);
  const modelSelect = useRef(null);
  const effortSelect = useRef(null);
  const historyIndex = useRef(-1);
  const savedText = useRef("");
  const sending = useRef(false);
  const selectedModel = options.model ?? settings.model ?? "";
  const selectedEffort = options.effort ?? settings.effort ?? "";
  const mode = options.mode || "default";
  const permission = options.permissions ? `profile:${options.permissions}` : mode;
  const approval = options.approvalPolicy ?? "default";
  const preset = permissionPresets.find((entry) => [entry.mode, `profile:${entry.profile}`].includes(permission) && entry.approvalPolicy === (approval === "default" ? settings.approvalPolicy : approval));
  const permissionValue = permission === "default" && approval === "default" ? "default" : preset?.mode || (options.permissions && !permissionPresets.some((entry) => entry.profile === options.permissions) && approval === "default" ? permission : "custom");
  const collaboration = options.collaborationMode ?? settings.collaborationMode ?? "default";
  const selectedSkills = options.skills || [];
  const available = models.find((entry) => entry.model === selectedModel) || models.find((entry) => entry.isDefault);
  const efforts = available?.supportedReasoningEfforts || [];
  const slash = !hidden && /^\/[^\s]*$/.test(text) ? COMMANDS.filter(([name]) => name.startsWith(text.slice(1))) : [];
  const mention = !hidden && text.match(/(?:^|\s)@([^\s@]*)$/);
  const skillMention = !hidden && text.match(/(?:^|\s)\$([^\s$]*)$/);
  const skillResults = (showSkills || skillMention) ? (skillCatalog?.skills || []).filter((skill) => skill.enabled && !selectedSkills.includes(skill.path) && (!skillMention || skill.name.toLowerCase().includes(skillMention[1].toLowerCase()))) : [];
  const suggestions = (slash.length ? slash.map(([name, description]) => ({ key: name, label: `/${name}`, description, kind: "command" })) : mention ? fileResults.map((file) => ({ key: file.path, label: file.path, description: "项目文件", kind: "file" })) : skillResults.map((skill) => ({ key: skill.path, label: skill.name, description: skill.interface?.shortDescription || skill.shortDescription || skill.description, kind: "skill" }))).slice(0, 12);

  useEffect(() => { sessionStorage.setItem(draftKey(storageKey), text); }, [storageKey, text]);
  useEffect(() => { sessionStorage.setItem(`${draftKey(storageKey)}:options`, JSON.stringify(options)); }, [storageKey, options]);
  useEffect(() => { setNotice(""); }, [selectedModel, selectedEffort, permission, approval, collaboration]);
  useEffect(() => {
    setPermissionCatalog(null); setPermissionError("");
    if (!cwd) return;
    let active = true;
    codexApi.permissions(cwd).then((value) => { if (active) setPermissionCatalog(value); }).catch((err) => { if (active) setPermissionError(err.message); });
    return () => { active = false; };
  }, [cwd]);
  useEffect(() => {
    let active = true;
    loadAttachments(storageKey).then((files) => { if (active) setAttachments(files); }).catch(() => { if (active) setError("附件草稿无法恢复，请重新添加"); }).finally(() => { if (active) setFilesReady(true); });
    return () => { active = false; };
  }, [storageKey]);
  useEffect(() => {
    if (filesReady) saveAttachments(storageKey, attachments).catch(() => setError("附件草稿无法保存，切换页面前请先发送"));
  }, [storageKey, attachments, filesReady]);
  useLayoutEffect(() => { const element = box.current; element.style.height = "auto"; element.style.height = `${Math.min(element.scrollHeight, 220)}px`; }, [text]);
  useEffect(() => { setIndex(0); }, [text, showSkills]);
  useEffect(() => {
    if (!mention || !cwd) { setFileResults([]); return; }
    let active = true;
    const timer = setTimeout(() => codexApi.files(cwd, mention[1]).then((result) => { if (active) setFileResults(result.files.slice(0, 10)); }).catch((err) => { if (active) setError(err.message); }), 160);
    return () => { active = false; clearTimeout(timer); };
  }, [cwd, mention?.[1]]);
  useEffect(() => {
    if ((!showSkills && !skillMention) || !cwd) { setSkillLoading(false); return; }
    if (skillCatalog) return;
    let active = true;
    setSkillLoading(true);
    codexApi.skills(cwd).then((result) => { if (active) setSkillCatalog(result); }).catch((err) => { if (active) { setError(err.message); setShowSkills(false); } }).finally(() => { if (active) setSkillLoading(false); });
    return () => { active = false; };
  }, [cwd, showSkills, Boolean(skillMention), skillCatalog]);

  function change(value) { setText(value); setHidden(false); historyIndex.current = -1; }

  async function addFiles(files) {
    setReading(true);
    setError("");
    try {
      if (attachments.length + files.length > 8) throw new Error("一次最多 8 个附件");
      const added = await Promise.all(files.map(readFile));
      setAttachments((current) => [...current, ...added].slice(0, 8));
    } catch (err) { setError(err.message); } finally { setReading(false); }
  }

  async function command(name) {
    if (name === "model" || name === "effort") {
      const element = name === "model" ? modelSelect.current : effortSelect.current;
      element.focus();
      try { element.showPicker?.(); } catch {}
    } else if (name === "skills") setShowSkills(true);
    else if (name === "skill-manager") setManageSkills(true);
    else if (name === "settings") await saveSettings();
    else if (name === "plan") {
      if (!collaborationModes.some((entry) => entry.mode === "plan")) throw new Error("此 CLI 未提供计划模式");
      setOptions((current) => ({ ...current, collaborationMode: collaboration === "plan" ? "default" : "plan" }));
    } else await onCommand(name);
  }

  async function saveSettings() {
    if (isNew) throw new Error("新会话会在首次发送时保存这些设置");
    setSaving(true); setError(""); setNotice("");
    try {
      await codexApi.settings(storageKey, { model: selectedModel, effort: selectedEffort, mode, ...(options.permissions ? { permissions: options.permissions } : {}), approvalPolicy: approval, ...(collaborationModes.length ? { collaborationMode: collaboration } : {}) });
      setNotice("会话设置已保存，下一轮生效");
    } finally { setSaving(false); }
  }

  async function pick(suggestion) {
    if (suggestion.kind === "command") {
      try { await command(suggestion.key); setText(""); sessionStorage.removeItem(draftKey(storageKey)); } catch (err) { setError(err.message); }
      setHidden(true);
    }
    else if (suggestion.kind === "file") { setText(text.replace(/@[^\s@]*$/, `@${/\s/.test(suggestion.label) ? `"${suggestion.label}"` : suggestion.label} `)); setHidden(true); }
    else {
      setOptions((current) => ({ ...current, skills: [...selectedSkills, suggestion.key] }));
      if (skillMention) setText(text.replace(/\$[^\s$]*$/, ""));
      setShowSkills(false); setHidden(true);
    }
    if (suggestion.kind !== "command") box.current?.focus();
  }

  async function send(delivery = "queue") {
    if (!ready || submitting || reading || sending.current) return;
    sending.current = true;
    try {
      const files = filesReady ? attachments : await loadAttachments(storageKey);
      if (!text.trim() && !files.length) return;
      setError("");
      const match = text.trim().match(/^\/([\w-]+)$/);
      if (match && COMMANDS.some(([name]) => name === match[1])) {
        await command(match[1]); setText(""); sessionStorage.removeItem(draftKey(storageKey));
        return;
      }
      const ok = await onSubmit(text, { model: selectedModel, effort: selectedEffort, mode, ...(options.permissions ? { permissions: options.permissions } : {}), approvalPolicy: approval, ...(collaborationModes.length ? { collaborationMode: collaboration } : {}), attachments: files, skills: selectedSkills, delivery, expectedTurnId: turnId });
      if (ok) {
        const historyKey = "codex-web-input-history";
        let history = [];
        try { history = JSON.parse(sessionStorage.getItem(historyKey) || "[]"); } catch {}
        if (text.trim()) sessionStorage.setItem(historyKey, JSON.stringify([...history.filter((entry) => entry !== text), text].slice(-30)));
        sessionStorage.removeItem(draftKey(storageKey));
        sessionStorage.setItem(`${draftKey(storageKey)}:options`, JSON.stringify({ ...options, skills: [] }));
        saveAttachments(storageKey, []).catch(() => {});
        setText(""); setAttachments([]); setOptions((current) => ({ ...current, skills: [] }));
        setHidden(false); setShowSkills(false); historyIndex.current = -1;
      }
    } catch (err) { setError(err.message); } finally { sending.current = false; }
  }

  function keyDown(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { setHidden(true); setShowSkills(false); return; }
    if (suggestions.length && ["ArrowDown", "ArrowUp", "Tab"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Tab") pick(suggestions[index % suggestions.length]);
      else setIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (suggestions.length && !event.ctrlKey && !event.metaKey) pick(suggestions[index % suggestions.length]);
      else send((event.ctrlKey || event.metaKey) && busy ? "steer" : "queue");
      return;
    }
    if (["ArrowUp", "ArrowDown"].includes(event.key) && (!text || historyIndex.current >= 0)) {
      let history = [];
      try { history = JSON.parse(sessionStorage.getItem("codex-web-input-history") || "[]"); } catch {}
      if (!history.length) return;
      event.preventDefault();
      if (historyIndex.current < 0) savedText.current = text;
      historyIndex.current = Math.max(-1, Math.min(history.length - 1, historyIndex.current + (event.key === "ArrowUp" ? 1 : -1)));
      setText(historyIndex.current < 0 ? savedText.current : history.at(-1 - historyIndex.current));
    }
  }

  const canSend = ready && !submitting && !reading && (text.trim() || attachments.length);
  return (
    <><form className={`codex-composer ${dragging ? "dragging" : ""}`} onSubmit={(event) => { event.preventDefault(); send(); }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!submitting && !reading && filesReady) addFiles([...event.dataTransfer.files]); }}>
      {isNew && <div className="codex-project-select"><Icon name="folder" /><select aria-label="Codex 项目目录" value={cwd} disabled={submitting} onChange={(event) => onProject(event.target.value)}><option value="">选择项目目录</option>{projects.map((project) => <option key={project.cwd} value={project.cwd}>{project.name} · {project.cwd}</option>)}</select><button type="button" className="icon-button" aria-label="添加项目目录" onClick={onAddProject}><Icon name="plus" /></button></div>}
      {suggestions.length > 0 && <div className="codex-suggestions" role="listbox" aria-label="Codex 输入建议">{suggestions.slice(0, 12).map((item, itemIndex) => <button type="button" role="option" aria-selected={itemIndex === index % suggestions.length} key={item.key} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(item)}><strong>{item.label}</strong><span>{item.description}</span></button>)}</div>}
      {skillLoading && <p className="faint-line"><Spinner /> 正在读取本地技能…</p>}
      {showSkills && skillCatalog && !skillResults.length && <p className="faint-line">没有可添加的技能<button type="button" className="meta-button" onClick={() => setShowSkills(false)}>关闭</button></p>}
      {showSkills && <p className="faint-line"><button type="button" className="btn" onClick={() => { setShowSkills(false); setManageSkills(true); }}>管理与刷新技能</button></p>}
      {skillCatalog?.errors?.length > 0 && showSkills && <p className="error-text">{skillCatalog.errors.map((entry) => entry.message).join("；")}</p>}
      {(attachments.length > 0 || selectedSkills.length > 0) && <div className="attachments">{attachments.map((file, fileIndex) => <span className="attachment" data-testid="codex-attachment" key={`${file.name}-${fileIndex}`}>{file.mimeType.startsWith("image/") ? <img src={`data:${file.mimeType};base64,${file.data}`} alt={file.name} /> : <Icon name="file" />}<span className="attachment-name">{file.name}</span><button type="button" disabled={submitting} aria-label={`移除附件 ${file.name}`} onClick={() => setAttachments((current) => current.filter((_, index) => index !== fileIndex))}><Icon name="x" size={13} /></button></span>)}{selectedSkills.map((selected) => <span className="attachment" key={selected}><Icon name="spark" /><span className="attachment-name">{skillCatalog?.skills.find((entry) => entry.path === selected)?.name || selected.split("/").slice(-2, -1)[0]}</span><button type="button" aria-label="移除技能" disabled={submitting} onClick={() => setOptions((current) => ({ ...current, skills: selectedSkills.filter((entry) => entry !== selected) }))}><Icon name="x" size={13} /></button></span>)}</div>}
      <textarea ref={box} rows={2} disabled={submitting} aria-label="发送给 Codex" data-testid="codex-composer" placeholder={busy ? "继续输入：Enter 排队，Ctrl/⌘+Enter 立即补充" : "给 Codex 一个任务…  / 命令 · @ 文件 · $ 技能"} value={text} onChange={(event) => change(event.target.value)} onKeyDown={keyDown} onPaste={(event) => { if (event.clipboardData.files.length && filesReady && !reading) { event.preventDefault(); addFiles([...event.clipboardData.files]); } }} />
      {error && <p className="error-text" role="alert">{error}</p>}
      {notice && <p className="faint-line" role="status">{notice}</p>}
      <input ref={picker} type="file" multiple hidden aria-label="Codex 附件" disabled={!filesReady || reading || submitting} onChange={(event) => { addFiles([...event.target.files]); event.target.value = ""; }} />
      <div className="codex-composer-controls">
        <button type="button" className="icon-button" aria-label="添加 Codex 附件" title="图片或 UTF-8 文本，最多 8 个，每个 8MB" disabled={!filesReady || reading || submitting} onClick={() => picker.current.click()}>{reading ? <Spinner /> : <Icon name="paperclip" />}</button>
        <button type="button" className="icon-button" aria-label="选择 Codex 技能" disabled={!cwd || submitting} onClick={() => { setShowSkills((current) => !current); setHidden(false); }}><Icon name="spark" /></button>
        <button type="button" className="icon-button" aria-label="管理 Codex 技能" disabled={!cwd || submitting} onClick={() => setManageSkills(true)}><Icon name="settings" /></button>
        <select ref={modelSelect} aria-label="Codex 模型" data-testid="codex-model" value={selectedModel} disabled={submitting} onChange={(event) => { const next = models.find((entry) => entry.model === event.target.value); setOptions((current) => ({ ...current, model: event.target.value, effort: next?.defaultReasoningEffort || "" })); }}>
          <option value="">{isNew ? "CLI 默认模型" : "沿用当前模型"}</option>
          {selectedModel && !models.some((entry) => entry.model === selectedModel) && <option value={selectedModel}>{selectedModel}</option>}
          {models.map((entry) => <option key={entry.id} value={entry.model}>{entry.displayName || entry.model}</option>)}
        </select>
        <select ref={effortSelect} aria-label="Codex 推理强度" value={selectedEffort} disabled={submitting} onChange={(event) => setOptions((current) => ({ ...current, effort: event.target.value }))}><option value="">沿用当前强度</option>{selectedEffort && !efforts.some((entry) => entry.reasoningEffort === selectedEffort) && <option value={selectedEffort}>{effortLabel(selectedEffort)}</option>}{efforts.map((entry) => <option key={entry.reasoningEffort} value={entry.reasoningEffort}>{effortLabel(entry.reasoningEffort)}</option>)}</select>
        <label className={`codex-permission-picker ${permissionValue === "danger-full-access" ? "full-access" : ""}`}><Icon name="shield" /><select aria-label="Codex 权限" title={`当前：${permissionLabel(settings)} · ${approvalLabel(settings.approvalPolicy)}；保存或发送后生效`} value={permissionValue} disabled={submitting} onChange={(event) => {
          const value = event.target.value;
          if (value === "advanced") { setShowPermissions(true); return; }
          const selected = permissionPresets.find((entry) => entry.mode === value);
          setOptions((current) => ({ ...current, mode: selected && !permissionCatalog?.supported ? selected.mode : "default", permissions: value.startsWith("profile:") ? value.slice(8) : selected && permissionCatalog?.supported ? selected.profile : undefined, approvalPolicy: selected?.approvalPolicy || "default" }));
        }}>
          <option value="default">沿用当前权限</option>
          {permissionPresets.map((entry) => { const profile = permissionCatalog?.profiles.find((profile) => profile.id === entry.profile); return <option key={entry.mode} value={entry.mode} disabled={profile?.allowed === false} title={entry.description}>{entry.label}{profile?.allowed === false ? "（本机策略禁止）" : ""}</option>; })}
          {permissionCatalog?.profiles.filter((entry) => !permissionPresets.some((preset) => preset.profile === entry.id)).map((entry) => <option key={entry.id} value={`profile:${entry.id}`} disabled={!entry.allowed} title={entry.description || entry.id}>{profileLabel(entry.id)}{entry.allowed ? "" : "（本机策略禁止）"}</option>)}
          {permissionValue === "custom" && <option value="custom" disabled>当前自定义权限</option>}
          <option value="advanced">自定义权限…</option>
        </select></label>
        {collaborationModes.length > 0 && <select aria-label="Codex 协作模式" value={collaboration} disabled={submitting} onChange={(event) => setOptions((current) => ({ ...current, collaborationMode: event.target.value }))}>{collaborationModes.map((entry) => <option key={entry.mode} value={entry.mode}>{entry.mode === "plan" ? "计划" : "执行"}</option>)}</select>}
        {!isNew && <button type="button" className="icon-button" aria-label="保存 Codex 会话设置" title="保存模型、强度、权限及协作模式，下一轮生效" disabled={busy || saving} onClick={() => saveSettings().catch((err) => setError(err.message))}>{saving ? <Spinner /> : <Icon name="check" />}</button>}
        <span className="spacer" />
        {canStop && <><button type="button" className="codex-steer" disabled={!canSend} onClick={() => send("steer")} title="补充到当前任务，Ctrl/⌘+Enter">立即补充</button><button type="button" className="icon-button" data-testid="codex-stop" aria-label="停止 Codex" onClick={onStop}><Icon name="stop" size={18} /></button></>}
        <button type="submit" className="codex-send" aria-label={busy ? "排队发送" : "发送"} title={busy ? "当前任务完成后发送" : "Enter 发送，Shift+Enter 换行"} disabled={!canSend}>{submitting ? <Spinner size={18} /> : <Icon name={busy ? "plus" : "arrowUp"} size={18} />}</button>
      </div>
      <p className="faint-line codex-permission-status" aria-label="Codex 当前权限">当前：{permissionLabel(settings)} · {approvalLabel(settings.approvalPolicy)}</p>
      {permissionError && <p className="error-text" role="alert">权限配置读取失败：{permissionError}</p>}
    </form>{showPermissions && <PermissionDialog initial={options} settings={settings} catalog={permissionCatalog} onClose={() => setShowPermissions(false)} onApply={(value) => { setOptions((current) => ({ ...current, ...value })); setShowPermissions(false); }} />}{manageSkills && <SkillManager cwd={cwd} onClose={() => setManageSkills(false)} onUpdate={(catalog) => { setSkillCatalog(catalog); setOptions((current) => ({ ...current, skills: (current.skills || []).filter((selected) => catalog.skills.some((skill) => skill.path === selected && skill.enabled)) })); }} />}</>
  );
}

async function readFile(file) {
  if (!file.size || file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 为空或超过 8MB`);
  if (file.type && !file.type.startsWith("text/") && !["application/octet-stream", "image/png", "image/jpeg", "image/gif", "image/webp", "application/json", "application/xml", "application/javascript", "application/x-sh", "application/sql"].includes(file.type) && !file.type.endsWith("+json") && !file.type.endsWith("+xml")) throw new Error(`${file.name} 暂不支持，请添加图片或 UTF-8 文本文件`);
  const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error(`${file.name} 读取失败`)); reader.readAsDataURL(file); });
  return { name: file.name, mimeType: file.type || "application/octet-stream", data };
}

export const commandHelp = COMMANDS;

function SkillManager({ cwd, onClose, onUpdate }) {
  const [catalog, setCatalog] = useState(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    codexApi.skills(cwd, true).then((value) => { if (active) { setCatalog(value); onUpdate(value); } }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [cwd]);
  return <Modal title="本地 Codex 技能" onClose={onClose}><p className="modal-text">启用状态会保存到本机 Codex 配置，CLI 也会使用此设置。选择技能后可随消息发送。</p><input className="field" aria-label="搜索本地技能" placeholder="搜索技能名称或描述" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="codex-skills-list">{catalog?.skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())).map((skill) => <div className="codex-skill-row" key={skill.path}><span><strong>{skill.name}</strong><small>{skill.interface?.shortDescription || skill.shortDescription || skill.description}</small><small className="mono">{skill.path}</small></span><button type="button" className={`switch ${skill.enabled ? "on" : ""}`} role="switch" aria-label={`启用技能 ${skill.name}`} aria-checked={skill.enabled} disabled={busy} onClick={async () => {
    setBusy(true); setError("");
    try { const value = await codexApi.skillConfig(cwd, skill.path, !skill.enabled); setCatalog(value); onUpdate(value); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }}><span /></button></div>)}</div>{catalog?.errors?.map((entry, index) => <p className="error-text" key={index}>{entry.message}</p>)}{error && <p className="error-text" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const value = await codexApi.skills(cwd, true); setCatalog(value); onUpdate(value); } catch (err) { setError(err.message); } finally { setBusy(false); } }}>{busy ? "读取中…" : "刷新技能"}</button><button type="button" className="btn primary" onClick={onClose}>完成</button></div></Modal>;
}

function PermissionDialog({ initial, settings, catalog, onClose, onApply }) {
  const [options, setOptions] = useState(() => ({ mode: initial.mode || "default", permissions: initial.permissions, approvalPolicy: initial.approvalPolicy ?? "default" }));
  const mode = options.mode;
  const permission = options.permissions ? `profile:${options.permissions}` : mode;
  const approval = options.approvalPolicy;
  return <Modal title="自定义权限" onClose={onClose} testId="codex-permissions-dialog">
    <p className="modal-text">访问范围决定能访问和修改哪里，操作确认决定何时向你申请审批。使用此设置后，保存或发送下一条消息才生效。</p>
        <label className="field-label">访问范围<select className="field" aria-label="Codex 自定义访问范围" title={`当前：${permissionLabel(settings)}；保存或发送后生效`} value={permission} onChange={(event) => { const value = event.target.value; setOptions((current) => ({ ...current, mode: value.startsWith("profile:") ? "default" : value, permissions: value.startsWith("profile:") ? value.slice(8) : undefined })); }}>
          <option value="default">沿用当前范围</option>
          {catalog?.supported ? <>
            {mode !== "default" && <option value={mode}>{sandboxLabels[mode] || mode}（沙箱模式）</option>}
            {options.permissions && !catalog.profiles.some((entry) => entry.id === options.permissions) && <option value={permission} disabled>{profileLabel(options.permissions)}（不可用）</option>}
            {catalog.profiles.map((entry) => <option key={entry.id} value={`profile:${entry.id}`} disabled={!entry.allowed} title={entry.description || entry.id}>{profileLabel(entry.id)}{entry.allowed ? "" : "（本机策略禁止）"}</option>)}
          </> : <>{options.permissions && <option value={permission} disabled>{profileLabel(options.permissions)}</option>}{Object.entries(sandboxLabels).filter(([key]) => key.includes("-")).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</>}
        </select></label>
        <label className="field-label">操作确认<select className="field" aria-label="Codex 审批策略" title={`当前：${approvalLabel(settings.approvalPolicy)}；保存或发送后生效`} value={typeof approval === "object" ? "granular" : approval} onChange={(event) => setOptions((current) => ({ ...current, approvalPolicy: event.target.value === "granular" ? { granular: settings.approvalPolicy?.granular || Object.fromEntries(granularFields.map(([key]) => [key, true])) } : event.target.value }))}>
          <option value="default">沿用当前审批</option>{Object.entries(approvalLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="granular">自定义审批类别</option>
        </select></label>
      {approval?.granular && <fieldset className="codex-granular-approval"><legend>允许提出审批的类别</legend>{granularFields.map(([key, label]) => <label key={key}><input type="checkbox" checked={Boolean(approval.granular[key])} onChange={(event) => setOptions((current) => ({ ...current, approvalPolicy: { granular: { ...approval.granular, [key]: event.target.checked } } }))} />{label}</label>)}<small>未勾选的类别由 CLI 自动拒绝；沙箱范围保持独立。</small></fieldset>}
    <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>取消</button><button type="button" className="btn primary" onClick={() => onApply(options)}>使用此设置</button></div>
  </Modal>;
}
