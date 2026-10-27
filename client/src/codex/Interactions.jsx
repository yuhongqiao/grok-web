import { useState } from "react";
import Icon from "../components/Icon.jsx";
import { FileChanges } from "./Transcript.jsx";

export default function CodexInteraction({ request, thread, onAnswer }) {
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const p = request.params;
  const question = request.method === "item/tool/requestUserInput";
  const fileChange = request.method === "item/fileChange/requestApproval";
  const permissions = request.method === "item/permissions/requestApproval";
  const elicitation = request.method === "mcpServer/elicitation/request";
  const browserApproval = elicitation && p.serverName?.startsWith("grok_web_browser_") && p._meta?.codex_approval_kind === "mcp_tool_call";
  const supportedForm = elicitation && ["form", "openai/form", "openaiForm"].includes(p.mode) && p.requestedSchema?.type === "object" && Object.values(p.requestedSchema.properties || {}).every((entry) => ["string", "boolean", "integer", "number"].includes(entry.type) || entry.type === "array" && (entry.items?.enum || entry.items?.anyOf));
  const url = elicitation && p.mode === "url" && /^https?:\/\//i.test(p.url) ? p.url : "";
  const decisions = p.availableDecisions || ["accept", "acceptForSession", "decline", "cancel"];
  const item = thread?.turns.flatMap((turn) => turn.items).find((entry) => entry.id === p.itemId);
  const submit = async (body) => {
    setBusy(true);
    setError("");
    try { await onAnswer(body); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <section className="codex-interaction" data-testid={question ? "codex-question" : "codex-approval"}>
      <div className="codex-interaction-title"><Icon name={question ? "message" : "shield"} />{question ? "Codex 需要你的回答" : browserApproval ? "确认内置浏览器操作" : elicitation ? `${p.serverName} 需要你的确认` : fileChange ? "确认文件修改" : permissions ? "确认本轮权限" : "确认执行命令"}</div>
      {p.reason && <p>{p.reason}</p>}
      {p.command && <pre className="code-box">{p.command}</pre>}
      {p.cwd && <p className="faint-line mono">{p.cwd}</p>}
      {fileChange && <FileChanges changes={item?.changes} />}
      {fileChange && p.grantRoot && <p className="mono">请求访问：{p.grantRoot}</p>}
      {permissions && <pre className="code-box">{JSON.stringify(p.permissions, null, 2)}</pre>}
      {p.additionalPermissions && <pre className="code-box">{JSON.stringify(p.additionalPermissions, null, 2)}</pre>}
      {elicitation && <p>{browserApproval ? "Codex CLI 要求你允许本次浏览器操作。" : p.message || p.description}</p>}
      {browserApproval && <p className="mono">{p._meta.tool_params?.action || "打开或读取页面"}{p._meta.tool_params?.url && ` · ${p._meta.tool_params.url}`}</p>}
      {elicitation && url && <p><a className="btn" href={url} target="_blank" rel="noopener noreferrer">打开验证页面</a></p>}
      {elicitation && !supportedForm && !url && <p className="faint-line">此验证需要支持该类型的 Codex 客户端。可以拒绝或取消请求。</p>}
      {supportedForm && Object.entries(p.requestedSchema.properties).map(([key, schema]) => <div className="codex-form-field" key={key}><span>{schema.title || key}{p.requestedSchema.required?.includes(key) ? " *" : ""}</span>{schema.description && <small>{schema.description}</small>}<ElicitationField schema={schema} value={answers[key] ?? schema.default} disabled={busy} label={schema.title || key} onChange={(value) => setAnswers((current) => ({ ...current, [key]: value }))} /></div>)}
      {question && p.questions.map((entry) => (
        <fieldset key={entry.id} disabled={busy}>
          <legend>{entry.question}</legend>
          {entry.options?.map((option) => (
            <label className="codex-choice" key={option.label}>
              <input type="radio" name={`${request.id}-${entry.id}`} checked={answers[entry.id] === option.label} onChange={() => setAnswers((current) => ({ ...current, [entry.id]: option.label }))} />
              <span>{option.label}<small>{option.description}</small></span>
            </label>
          ))}
          <input className="field" type={entry.isSecret ? "password" : "text"} autoComplete="off" aria-label={entry.question} placeholder="输入你的回答" value={answers[entry.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [entry.id]: event.target.value }))} />
        </fieldset>
      ))}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions">
        {question ? <><button className="btn" disabled={busy} onClick={() => submit({ skip: true })}>跳过</button><button className="btn primary" disabled={busy || p.questions.some((entry) => !answers[entry.id]?.trim())} onClick={() => submit({ answers })}>提交回答</button></> : elicitation ? <>
          <button className="btn" disabled={busy} onClick={() => submit({ action: "cancel" })}>取消</button><button className="btn" disabled={busy} onClick={() => submit({ action: "decline" })}>拒绝</button>
          {(supportedForm || url) && <button className="btn primary" disabled={busy} onClick={() => submit({ action: "accept", content: Object.fromEntries(Object.entries(p.requestedSchema?.properties || {}).map(([key, schema]) => [key, answers[key] ?? schema.default ?? (schema.type === "boolean" ? false : undefined)])) })}>{browserApproval ? "允许这次" : url ? "已完成验证" : "提交信息"}</button>}
        </> : <>
          {!permissions && decisions.includes("cancel") && <button className="btn" disabled={busy} onClick={() => submit({ decision: "cancel" })}>拒绝并停止</button>}
          {(permissions || decisions.includes("decline")) && <button className="btn" data-testid="codex-deny" disabled={busy} onClick={() => submit({ decision: "decline" })}>拒绝</button>}
          {!permissions && decisions.includes("acceptForSession") && <button className="btn" disabled={busy} title={fileChange ? "本会话后续对相同文件的修改无需再次确认" : "本会话内符合 CLI 审批缓存的同类请求无需再次确认"} onClick={() => submit({ decision: "acceptForSession" })}>本会话允许</button>}
          {(permissions || decisions.includes("accept")) && <button className="btn primary" data-testid="codex-allow" disabled={busy} onClick={() => submit({ decision: "accept" })}>{permissions ? "允许本轮" : "允许这次"}</button>}
        </>}
      </div>
    </section>
  );
}

function ElicitationField({ schema, value, onChange, label, disabled }) {
  if (schema.type === "boolean") return <input type="checkbox" aria-label={label} disabled={disabled} checked={value === true} onChange={(event) => onChange(event.target.checked)} />;
  const choices = schema.enum?.map((value, index) => ({ value, title: schema.enumNames?.[index] || value })) || schema.oneOf?.map((entry) => ({ value: entry.const, title: entry.title || entry.const }));
  if (choices) return <select className="field" aria-label={label} disabled={disabled} value={value || ""} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option>{choices.map((entry) => <option key={entry.value} value={entry.value}>{entry.title}</option>)}</select>;
  if (schema.type === "array") {
    const entries = schema.items.enum?.map((value) => ({ const: value, title: value })) || schema.items.anyOf;
    return <span>{entries.map((entry) => <label className="codex-choice" key={entry.const}><input type="checkbox" disabled={disabled} checked={(value || []).includes(entry.const)} onChange={(event) => onChange(event.target.checked ? [...(value || []), entry.const] : (value || []).filter((item) => item !== entry.const))} />{entry.title || entry.const}</label>)}</span>;
  }
  const numeric = ["integer", "number"].includes(schema.type);
  return <input className="field" aria-label={label} autoComplete="off" disabled={disabled} type={numeric ? "number" : schema.format === "email" ? "email" : "text"} step={schema.type === "integer" ? 1 : "any"} min={schema.minimum} max={schema.maximum} minLength={schema.minLength} maxLength={schema.maxLength} value={value ?? ""} onChange={(event) => onChange(numeric && event.target.value !== "" ? Number(event.target.value) : event.target.value)} />;
}
