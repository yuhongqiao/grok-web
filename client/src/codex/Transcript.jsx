import { useState } from "react";
import { Markdown } from "../components/Message.jsx";
import Icon, { Spinner } from "../components/Icon.jsx";
import { duration } from "../format.js";
import { threadTitle } from "./protocol.js";
import { threadLink } from "./links.js";
import { isBrowserCall, browserLabel } from "./browser.js";

const STATUSES = { inProgress: "进行中", completed: "已完成", failed: "失败", declined: "已拒绝", interrupted: "已停止" };

export function CodexTurn({ turn, threadId, onImage, onFork, canFork, onRevise, canRevert, onError }) {
  const [copied, setCopied] = useState(false);
  const reply = turn.items.filter((item) => ["agentMessage", "plan"].includes(item.type)).map((item) => item.text).filter(Boolean).join("\n\n");
  return (
    <section className="codex-turn" data-testid="codex-turn" data-turn-id={turn.id}>
      {turn.items.map((item) => <CodexItem key={item.id} item={item} threadId={threadId} onImage={onImage} />)}
      {turn.plan?.length > 0 && (
        <div className="plan-block">
          <div className="plan-title"><Icon name="list" />任务计划</div>
          {turn.explanation && <p className="faint-line">{turn.explanation}</p>}
          {turn.plan.map((step, index) => (
            <div className={`plan-entry ${step.status === "inProgress" ? "in_progress" : step.status}`} key={index}>
              {step.status === "completed" ? <Icon name="check" /> : step.status === "inProgress" ? <Spinner /> : <span className="plan-dot" />}
              <span>{step.step}</span>
            </div>
          ))}
        </div>
      )}
      {turn.error?.message && <p className="error-text" role="alert">{turn.error.message}</p>}
      <div className="answer-meta">
        <button className="meta-button" aria-label="复制 Codex 本轮链接" title="复制本轮链接" onClick={() => navigator.clipboard.writeText(threadLink(threadId, turn.id)).catch(() => onError("复制失败，请检查浏览器剪贴板权限"))}><Icon name="link" size={14} /></button>
        {reply && <button className="meta-button" aria-label="复制 Codex 回复" title="复制本轮回复" onClick={async () => { try { await navigator.clipboard.writeText(reply); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { onError("复制失败，请检查浏览器剪贴板权限"); } }}><Icon name={copied ? "check" : "copy"} size={14} /></button>}
        {turn.status !== "inProgress" && <button className="meta-button" aria-label="从此轮分叉 Codex 会话" title="从此轮分叉，不会回退项目文件" disabled={!canFork} onClick={onFork}><Icon name="fork" size={14} /></button>}
        {turn.status !== "inProgress" && turn.items.some((item) => item.type === "userMessage") && <>
          <button className="meta-button" aria-label="编辑 Codex 本轮输入" title="编辑输入并在新分支发送，保留原会话" disabled={!canFork} onClick={() => onRevise("edit")}><Icon name="pencil" size={14} /></button>
          <button className="meta-button" aria-label="重试 Codex 本轮" title="在新分支重试本轮初始输入，含附件" disabled={!canFork} onClick={() => onRevise("retry")}><Icon name="refresh" size={14} /></button>
        </>}
        {turn.status !== "inProgress" && canRevert && <button className="meta-button" aria-label="回退 Codex 到此轮之前" title="移除此轮及后续对话，不回退项目文件" disabled={!canFork} onClick={() => onRevise("revert")}><Icon name="undo" size={14} /></button>}
        {turn.status === "inProgress" ? <><Spinner />Codex 正在处理</> : <span>{STATUSES[turn.status] || turn.status}</span>}
        {turn.durationMs > 0 && <span>用时 {duration(turn.durationMs)}</span>}
      </div>
    </section>
  );
}

export function CodexTrace({ turns }) {
  if (!turns.some((turn) => turn.items.some((item) => !["userMessage", "agentMessage", "hookPrompt"].includes(item.type)))) return <p className="faint-line">此会话还没有工具调用或思考摘要。</p>;
  return turns.map((turn, index) => <section className="codex-turn" key={turn.id}><div className="faint-line">第 {index + 1} 轮 · {STATUSES[turn.status] || turn.status}</div>{turn.items.filter((item) => !["userMessage", "agentMessage", "hookPrompt"].includes(item.type)).map((item) => <CodexItem key={item.id} item={item} />)}{turn.diff && <details className="codex-detail"><summary><Icon name="pencil" />本轮完整 diff</summary><pre className="code-box">{turn.diff}</pre></details>}</section>);
}

export function exportThread(thread) {
  const lines = [`# ${threadTitle(thread)}`, "", `项目：${thread.cwd}`, `会话：${thread.id}`, ""];
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") lines.push("## 用户", "", ...(item.content || []).map((part) => part.type === "text" ? part.text : part.type === "image" || part.type === "localImage" ? `[图片${part.path ? `：${part.path}` : ""}]` : `[${part.type}：${part.name || part.path || ""}]`), "");
      else if (["agentMessage", "plan"].includes(item.type)) lines.push("## Codex", "", item.text || "", "");
      else if (item.type === "commandExecution") lines.push("### 命令", "", "```sh", item.command || "", "```", "", "```text", item.aggregatedOutput || "", "```", "");
      else if (item.type === "fileChange") for (const change of item.changes || []) lines.push(`### ${change.path}`, "", "```diff", change.diff || "", "```", "");
    }
    lines.push(`*${STATUSES[turn.status] || turn.status}*`, "");
  }
  return lines.join("\n");
}

export function FileChanges({ changes = [] }) {
  return changes.map((change, index) => (
    <div className="diff" key={`${change.path}-${index}`}>
      <div className="diff-path"><Icon name="file" />{change.path}</div>
      <pre className="code-box">{change.diff || change.kind?.type || "文件修改"}</pre>
    </div>
  ));
}

function CodexItem({ item, threadId, onImage }) {
  if (item.type === "userMessage") {
    return <div className="msg user" data-role="user"><div className="bubble">{(item.content || []).map((part, index) => {
      if (part.type === "text") {
        if (part.text.startsWith("附件：")) { const split = part.text.indexOf("\n"); return <details className="codex-attachment-text" key={index}><summary><Icon name="file" />{part.text.slice(0, split)}</summary><pre className="code-box">{part.text.slice(split + 1)}</pre></details>; }
        return <div className="bubble-text" key={index}>{part.text}</div>;
      }
      if (["image", "localImage"].includes(part.type)) {
        const src = part.type === "localImage" ? `/api/codex/threads/${encodeURIComponent(threadId)}/images/${encodeURIComponent(item.id)}/${index}` : part.url;
        return src ? <button className="codex-user-image" type="button" key={index} onClick={() => onImage?.(src)}><img alt="Codex 附件图片" src={src} onError={(event) => { event.currentTarget.alt = "图片不可用，请在本地查看"; }} /></button> : <span className="chip" key={index}>图片</span>;
      }
      return <span className="chip" title={part.path} key={index}><Icon name={part.type === "skill" ? "spark" : "file"} size={13} />{part.name || part.path || part.type}</span>;
    })}</div></div>;
  }
  if (item.type === "agentMessage" || item.type === "plan") return <div className="msg assistant" data-role="assistant"><Markdown text={item.text || ""} /></div>;
  if (item.type === "reasoning") {
    const summary = item.summary?.join("\n\n");
    return summary ? <details className="codex-detail"><summary><Icon name="bulb" />思考摘要</summary><div className="codex-detail-body"><Markdown text={summary} /></div></details> : null;
  }
  if (item.type === "hookPrompt") return null;
  if (item.type === "contextCompaction") return <p className="faint-line">上下文已压缩</p>;

  let label;
  let icon = "tool";
  let content;
  if (item.type === "commandExecution") {
    label = item.command || "执行命令";
    icon = "terminal";
    content = <><pre className="code-box">{item.command}</pre>{item.aggregatedOutput && <pre className="code-box">{item.aggregatedOutput}</pre>}{item.exitCode != null && <div className="faint-line">退出码 {item.exitCode}</div>}</>;
  } else if (item.type === "fileChange") {
    label = `修改 ${item.changes?.length || 0} 个文件`;
    icon = "pencil";
    content = <FileChanges changes={item.changes} />;
  } else if (isBrowserCall(item)) {
    label = `内置浏览器 · ${browserLabel(item)}`;
    icon = "globe";
    const { text, variables, ...args } = item.arguments || {};
    content = <>{args.url && <p className="mono">{args.url}</p>}{args.selector && <p className="mono">{args.selector}</p>}{args.reason && <p>{args.reason}</p>}{item.error && <p className="error-text">{item.error.message || JSON.stringify(item.error)}</p>}{item.result?.content?.map((part, index) => part.type === "image" ? <img className="codex-image-preview" key={index} alt="浏览器检查截图" src={`data:${part.mimeType};base64,${part.data}`} /> : part.type === "text" ? <pre className="code-box" key={index}>{part.text}</pre> : null)}</>;
  } else if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.type)) {
    label = [item.server || item.namespace, item.tool].filter(Boolean).join(" / ");
    content = <>{item.arguments != null && <pre className="code-box">{JSON.stringify(item.arguments, null, 2)}</pre>}{(item.result || item.error || item.contentItems || item.agentsStates) && <pre className="code-box">{JSON.stringify(item.result || item.error || item.contentItems || item.agentsStates, null, 2)}</pre>}</>;
  } else if (item.type === "webSearch") {
    label = `搜索：${item.query}`;
    icon = "globe";
    content = <pre className="code-box">{JSON.stringify(item.action || item.results || item.query, null, 2)}</pre>;
  } else if (item.type === "functionCallOutput") {
    label = item.name || "工具输出";
    content = <pre className="code-box">{typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2)}</pre>;
  } else if (item.type === "imageView") {
    label = "查看图片";
    content = <p className="mono">{item.path}</p>;
  } else if (item.type === "exitedReviewMode") {
    return <div className="msg assistant"><Markdown text={item.review} /></div>;
  } else return null;

  return (
    <details className="codex-detail" data-testid="codex-tool">
      <summary>{item.status === "inProgress" ? <Spinner /> : <Icon name={icon} />}<span className="codex-tool-label">{label}</span>{item.status && <span className={`badge ${item.status === "failed" ? "bad" : ""}`}>{STATUSES[item.status] || item.status}</span>}</summary>
      <div className="codex-detail-body">{content}</div>
    </details>
  );
}
