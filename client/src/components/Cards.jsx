import { useState } from "react";
import { toolLabel } from "../tools.js";
import Icon from "./Icon.jsx";
import { DiffView, Markdown } from "./Message.jsx";

const OPTION_NAMES = {
  allow_once: "允许",
  allow_always: "总是允许",
  reject_once: "拒绝",
  reject_always: "总是拒绝",
};

function optionName(option) {
  if (option.optionId === "allow-edits-session") return "本会话里改文件都允许";
  return OPTION_NAMES[option.kind] || option.name;
}

export function PermissionCard({ interaction, tool, cwd, onAnswer, onRejectWith }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = tool || { name: interaction.tool, kind: interaction.toolKind, title: interaction.title, input: interaction.input, diffs: [] };
  const input = interaction.input && typeof interaction.input === "object" ? interaction.input : {};
  const reject = interaction.options.find((option) => option.kind.startsWith("reject"));
  const answer = async (body) => {
    setBusy(true);
    try {
      await onAnswer(body);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="permission">
      <div className="card-head">
        <Icon name="shield" size={16} />
        <strong>需要你批准</strong>
        <span className="card-sub">{toolLabel(shown, cwd)}</span>
      </div>
      <div className="card-body">
        {input.command && <pre className="code-box"><span className="prompt">$ </span>{input.command}</pre>}
        {shown.diffs?.slice(0, 3).map((diff, index) => <DiffView key={index} diff={diff} cwd={cwd} />)}
        {!input.command && !shown.diffs?.length && interaction.input != null && (
          <pre className="code-box faint">{JSON.stringify(interaction.input, null, 2).slice(0, 3000)}</pre>
        )}
      </div>
      <div className="card-actions">
        {interaction.options.map((option, index) => (
          <button
            key={option.optionId}
            type="button"
            disabled={busy}
            className={option.kind.startsWith("reject") ? "btn" : index === 0 ? "btn primary" : "btn"}
            data-testid={`permission-${option.optionId}`}
            onClick={() => answer({ optionId: option.optionId })}
          >
            {optionName(option)}
          </button>
        ))}
      </div>
      {reject && (
        <form
          className="card-reply"
          onSubmit={(event) => {
            event.preventDefault();
            if (reply.trim()) onRejectWith(reject.optionId, reply.trim());
          }}
        >
          <input value={reply} placeholder="或者拒绝，并告诉 Grok 换个做法…" onChange={(event) => setReply(event.target.value)} />
          <button type="submit" className="btn" disabled={!reply.trim() || busy}>拒绝并发送</button>
        </form>
      )}
    </div>
  );
}

export function QuestionCard({ interaction, onAnswer }) {
  const [picks, setPicks] = useState(() => interaction.questions.map(() => []));
  const [others, setOthers] = useState(() => interaction.questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const toggle = (index, label, multi) => {
    setPicks((current) => current.map((list, at) => {
      if (at !== index) return list;
      if (!multi) return [label];
      return list.includes(label) ? list.filter((item) => item !== label) : [...list, label];
    }));
    if (!multi) setOthers((current) => current.map((value, at) => (at === index ? "" : value)));
  };
  const answered = interaction.questions.every((_question, index) => picks[index].length || others[index].trim());
  const submit = async (body) => {
    setBusy(true);
    try {
      await onAnswer(body);
    } finally {
      setBusy(false);
    }
  };
  const answers = () => Object.fromEntries(interaction.questions.map((question, index) => {
    const other = others[index].trim();
    if (question.multiSelect) return [question.question, other ? [...picks[index], other] : picks[index]];
    return [question.question, other || picks[index][0] || ""];
  }));
  return (
    <div className="card" data-testid="question">
      <div className="card-head"><Icon name="message" size={16} /><strong>Grok 想问你</strong></div>
      <div className="card-body">
        {interaction.questions.map((question, index) => (
          <div key={question.question} className="question">
            <div className="question-title">{question.question}{question.multiSelect && <span className="card-sub">可多选</span>}</div>
            {question.options.map((option) => {
              const selected = picks[index].includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`choice ${selected ? "selected" : ""}`}
                  data-testid="choice"
                  onClick={() => toggle(index, option.label, question.multiSelect)}
                >
                  <span className={`choice-mark ${question.multiSelect ? "square" : ""}`}>{selected && <Icon name="check" size={12} />}</span>
                  <span className="choice-label">{option.label}</span>
                  {option.description && <span className="choice-desc">{option.description}</span>}
                </button>
              );
            })}
            <input
              className="choice-other"
              placeholder="其他答案…"
              value={others[index]}
              onChange={(event) => {
                const value = event.target.value;
                setOthers((current) => current.map((item, at) => (at === index ? value : item)));
                if (!question.multiSelect && value) setPicks((current) => current.map((list, at) => (at === index ? [] : list)));
              }}
            />
          </div>
        ))}
      </div>
      <div className="card-actions">
        <button type="button" className="btn primary" disabled={!answered || busy} data-testid="question-submit" onClick={() => submit({ answers: answers() })}>提交回答</button>
        <button type="button" className="btn" disabled={busy} onClick={() => submit({ skip: true })}>跳过</button>
      </div>
    </div>
  );
}

export function PlanCard({ interaction, onAnswer }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (body) => {
    setBusy(true);
    try {
      await onAnswer(body);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" data-testid="plan-card">
      <div className="card-head"><Icon name="map" size={16} /><strong>计划写好了，等你批准</strong></div>
      <div className="card-body plan-preview">
        {interaction.plan ? <Markdown text={interaction.plan} /> : <span className="card-sub">计划是空的</span>}
      </div>
      <textarea
        className="card-feedback"
        rows={2}
        placeholder="要改哪里？写下意见再点「按意见修改」"
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
      />
      <div className="card-actions">
        <button type="button" className="btn primary" disabled={busy} data-testid="plan-approve" onClick={() => submit({ outcome: "approved" })}>批准，开始执行</button>
        <button type="button" className="btn" disabled={busy} data-testid="plan-revise" onClick={() => submit({ outcome: "revise", feedback })}>按意见修改</button>
        <button type="button" className="btn ghost-danger" disabled={busy} onClick={() => submit({ outcome: "abandoned" })}>放弃计划</button>
      </div>
    </div>
  );
}
