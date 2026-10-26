import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { messageText } from "../transcript.js";
import { duration, shortPath, stamp, tokens } from "../format.js";
import { GROUP_ICONS, diffStats, isRunning, lineDiff, statusLabel, summarizeTools, toolGroup, toolLabel } from "../tools.js";
import Icon, { Spinner } from "./Icon.jsx";

const MARKDOWN_COMPONENTS = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

export const Markdown = memo(function Markdown({ text }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export const UserMessage = memo(function UserMessage({ message, onImage }) {
  return (
    <div className="msg user" data-testid="message" data-role="user">
      <div className="bubble">
        {message.images?.length > 0 && (
          <div className="bubble-images">
            {message.images.map((image, index) => (image.data ? (
              <button type="button" key={index} onClick={() => onImage?.(image)}>
                <img alt="图片" src={`data:${image.mimeType};base64,${image.data}`} />
              </button>
            ) : <span key={index} className="chip"><Icon name="image" size={13} />图片</span>))}
          </div>
        )}
        {message.files?.length > 0 && (
          <div className="bubble-files">
            {message.files.map((name, index) => <span key={index} className="chip"><Icon name="file" size={13} />{name}</span>)}
          </div>
        )}
        {message.text && <div className="bubble-text">{message.text}</div>}
      </div>
    </div>
  );
});

export function Note({ message }) {
  return (
    <div className={`note ${message.tone || ""}`} data-testid="note">
      {message.tone === "btw" ? (
        <>
          <div className="note-head"><Icon name="message" size={14} />旁问 · {message.question}</div>
          <Markdown text={message.text} />
        </>
      ) : message.markdown ? <Markdown text={message.text} /> : message.text}
    </div>
  );
}

function groupBlocks(blocks) {
  const groups = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (block.type === "tool" && last?.type === "tools") last.tools.push(block);
    else if (block.type === "tool") groups.push({ type: "tools", tools: [block] });
    else groups.push(block);
  }
  return groups;
}

export const AssistantMessage = memo(function AssistantMessage({ message, index, live, cwd, thinkingOpen, onAction }) {
  const groups = groupBlocks(message.blocks);
  const last = groups.length - 1;
  return (
    <div className="msg assistant" data-testid="message" data-role="assistant">
      {groups.map((group, index) => {
        const active = live && index === last;
        if (group.type === "text") return <Markdown key={index} text={group.text} />;
        if (group.type === "thinking") return <Thinking key={index} text={group.text} active={active} open={thinkingOpen} />;
        if (group.type === "tools") return <ToolGroup key={index} tools={group.tools} cwd={cwd} active={active} />;
        if (group.type === "plan") return <PlanBlock key={index} entries={group.entries} />;
        return null;
      })}
      {live && !message.meta && (!groups.length || groups[last]?.type === "text") && <Dots />}
      {message.meta && <Footer message={message} onAction={(action, target) => onAction?.(action, target, index)} />}
    </div>
  );
});

export function Dots() {
  return <div className="dots" aria-label="正在回复"><span /><span /><span /></div>;
}

function Thinking({ text, active, open }) {
  const [expanded, setExpanded] = useState(null);
  const shown = expanded ?? (active || open);
  const first = text.trim().split("\n")[0].slice(0, 80);
  return (
    <div className={`thinking ${shown ? "open" : ""}`}>
      <button type="button" className="thinking-head" onClick={() => setExpanded(!shown)}>
        {active ? <Spinner size={13} /> : <Icon name="bulb" size={14} />}
        <span>{active ? "正在思考" : "思考过程"}</span>
        {!shown && <span className="thinking-preview">{first}</span>}
        <Icon name={shown ? "chevronDown" : "chevronRight"} size={14} className="chev" />
      </button>
      {shown && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function ToolGroup({ tools, cwd, active }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 1) return <ToolRow tool={tools[0]} cwd={cwd} />;
  const running = tools.find(isRunning);
  const failed = tools.filter((tool) => tool.status === "failed").length;
  return (
    <div className={`tool-group ${open ? "open" : ""}`}>
      <button type="button" className="tool-head" data-testid="tool-group" onClick={() => setOpen(!open)}>
        {running && active ? <Spinner size={13} /> : <Icon name="list" size={14} />}
        <span className="tool-summary">{summarizeTools(tools)}</span>
        {running && active && <span className="tool-now">{toolLabel(running, cwd)}</span>}
        {failed > 0 && <span className="badge bad">{failed} 个失败</span>}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="chev" />
      </button>
      {open && <div className="tool-list">{tools.map((tool) => <ToolRow key={tool.id} tool={tool} cwd={cwd} nested />)}</div>}
    </div>
  );
}

export function ToolRow({ tool, cwd, nested = false, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const group = toolGroup(tool);
  const running = isRunning(tool);
  const stats = tool.diffs?.length ? diffStats(tool.diffs) : null;
  return (
    <div className={`tool-row ${nested ? "nested" : ""} ${tool.status}`} data-testid="tool">
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        {running ? <Spinner size={13} /> : <Icon name={GROUP_ICONS[group]} size={14} />}
        <span className={`tool-label ${group === "execute" ? "mono" : ""}`}>{toolLabel(tool, cwd)}</span>
        {stats && (stats.added || stats.removed) ? <span className="diff-stat"><b className="add">+{stats.added}</b> <b className="del">-{stats.removed}</b></span> : null}
        {tool.status === "failed" && <span className="badge bad">失败</span>}
        {running && <span className="badge">{statusLabel(tool.status)}</span>}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="chev" />
      </button>
      {open && <ToolDetail tool={tool} cwd={cwd} />}
    </div>
  );
}

export function ToolDetail({ tool, cwd }) {
  const input = tool.input && typeof tool.input === "object" ? tool.input : null;
  const group = toolGroup(tool);
  const rest = input ? Object.fromEntries(Object.entries(input).filter(([key]) => !["content", "old_string", "new_string", "command"].includes(key))) : null;
  return (
    <div className="tool-detail">
      {group === "execute" && input?.command && <pre className="code-box"><span className="prompt">$ </span>{input.command}</pre>}
      {tool.diffs?.map((diff, index) => <DiffView key={index} diff={diff} cwd={cwd} />)}
      {!tool.diffs?.length && group !== "execute" && rest && Object.keys(rest).length > 0 && (
        <pre className="code-box faint">{JSON.stringify(rest, null, 2)}</pre>
      )}
      {tool.output && <pre className={`code-box ${tool.status === "failed" ? "bad" : ""}`}>{tool.output}</pre>}
    </div>
  );
}

export function DiffView({ diff, cwd }) {
  const rows = lineDiff(diff.oldText, diff.newText);
  return (
    <div className="diff">
      <div className="diff-path"><Icon name="file" size={13} />{shortPath(diff.path, cwd)}</div>
      <pre className="diff-body">
        {rows.map((row, index) => (
          <div key={index} className={`diff-line ${row.type}`}>
            <span className="diff-sign">{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}</span>
            {row.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function PlanBlock({ entries }) {
  return (
    <div className="plan-block">
      <div className="plan-title"><Icon name="list" size={14} />待办</div>
      {entries.map((entry, index) => (
        <div key={index} className={`plan-entry ${entry.status}`}>
          {entry.status === "completed" ? <Icon name="check" size={14} /> : entry.status === "in_progress" ? <Spinner size={12} /> : <span className="plan-dot" />}
          <span>{entry.content}</span>
        </div>
      ))}
    </div>
  );
}

function Footer({ message, onAction }) {
  const { meta } = message;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(messageText(message));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      onAction?.("copy-failed");
    }
  };
  return (
    <div className="answer-meta">
      {messageText(message) && (
        <button type="button" className="meta-button" title="复制" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={15} />
        </button>
      )}
      <button type="button" className="meta-button" title="从这一轮分叉" onClick={() => onAction?.("fork", message)}>
        <Icon name="fork" size={15} />
      </button>
      <button type="button" className="meta-button" title="回退到这一轮" onClick={() => onAction?.("rewind", message)}>
        <Icon name="undo" size={15} />
      </button>
      {meta.stopReason === "cancelled" && <span className="badge">已停止</span>}
      {meta.usage?.total > 0 && <span className="meta-item"><Icon name="database" size={14} />用量 {tokens(meta.usage.total)} tok</span>}
      {meta.elapsedMs > 0 && <span className="meta-item"><Icon name="clock" size={14} />用时 {duration(meta.elapsedMs)}</span>}
      {meta.endedAt && <span className="meta-item">{stamp(meta.endedAt)}</span>}
    </div>
  );
}
