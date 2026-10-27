import { useEffect, useMemo, useRef, useState } from "react";
import { SOURCE_LABELS, parseSlash, suggestions } from "../commands.js";
import { MODE_ORDER, MODES, effortLabel } from "../format.js";
import { api } from "../api.js";
import Icon, { Spinner } from "./Icon.jsx";

const MAX_FILES = 8;
const MAX_BYTES = 8 * 1024 * 1024;

// A menu that opens upward from its button and closes on an outside click or Esc.
export function Popover({ label, className = "", testId, title, children, align = "left", disabled = false }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!box.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className={`popover ${className}`} ref={box}>
      <button type="button" className="pill" data-testid={testId} title={title} disabled={disabled} onClick={() => setOpen(!open)}>
        {label}
        <Icon name="chevronDown" size={13} className="chev" />
      </button>
      {open && (
        <div className={`menu up ${align}`} data-testid={testId ? `${testId}-menu` : undefined} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ selected, onClick, icon, title, hint, testId }) {
  return (
    <button type="button" className={`menu-item ${selected ? "selected" : ""}`} role="menuitemradio" aria-checked={selected} data-testid={testId} onClick={onClick}>
      {icon && <Icon name={icon} size={15} />}
      <span className="menu-text">
        <span className="menu-title">{title}</span>
        {hint && <span className="menu-hint">{hint}</span>}
      </span>
      {selected && <Icon name="check" size={14} className="menu-check" />}
    </button>
  );
}

export default function Composer({
  draftKey,
  catalog,
  sessions,
  running,
  queue,
  busy,
  encoded,
  draftProject,
  onPickProject,
  model,
  effort,
  models,
  efforts,
  mode,
  onSubmit,
  onStop,
  onSettings,
  onQueue,
  multiline,
  history,
  seed,
}) {
  const box = useRef(null);
  const picker = useRef(null);
  const [text, setText] = useState(() => sessionStorage.getItem(`grok-web-draft:${draftKey}`) || "");
  const [files, setFiles] = useState([]);
  const [fileError, setFileError] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuHidden, setMenuHidden] = useState(false);
  const [historyAt, setHistoryAt] = useState(-1);
  const [mention, setMention] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    sessionStorage.setItem(`grok-web-draft:${draftKey}`, text);
  }, [draftKey, text]);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    setTimeout(() => {
      box.current?.focus();
      box.current?.setSelectionRange(seed.text.length, seed.text.length);
    }, 0);
  }, [seed]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [text]);

  const slash = useMemo(() => (menuHidden ? [] : suggestions(text, catalog, sessions)), [text, catalog, sessions, menuHidden]);

  useEffect(() => {
    setMenuIndex(0);
  }, [text, mention?.query]);

  // `@` mentions search the project's files.
  useEffect(() => {
    if (!mention || !encoded) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.files(encoded, mention.query).then((result) => {
        if (!cancelled) setMention((current) => (current && current.query === mention.query ? { ...current, files: result.files } : current));
      }, () => {});
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention?.query, encoded]);

  const items = mention?.files?.length ? mention.files.map((path) => ({ path })) : slash;
  const menuKind = mention?.files?.length ? "files" : slash.length ? "slash" : "";

  const updateMention = (value, caret) => {
    const before = value.slice(0, caret);
    const match = before.match(/(^|\s)@([^\s@]*)$/);
    setMention(match ? { query: match[2], start: caret - match[2].length - 1, end: caret, files: mention?.files || [] } : null);
  };

  const addFiles = async (list) => {
    const incoming = [...list];
    if (files.length + incoming.length > MAX_FILES) {
      setFileError("一次最多 8 个附件");
      return;
    }
    const next = [];
    for (const file of incoming) {
      if (file.size > MAX_BYTES) {
        setFileError(`${file.name} 超过 8MB`);
        return;
      }
      next.push(await readAttachment(file));
    }
    setFileError("");
    setFiles((current) => [...current, ...next]);
  };

  const submit = async ({ now = false } = {}) => {
    const value = text.trim();
    if ((!value && !files.length) || sending) return;
    setSending(true);
    try {
      const ok = await onSubmit(value, files, { now });
      if (ok !== false) {
        sessionStorage.removeItem(`grok-web-draft:${draftKey}`);
        setText("");
        setFiles([]);
        setHistoryAt(-1);
        setMenuHidden(false);
        setMention(null);
      }
    } finally {
      setSending(false);
    }
  };

  const pick = (item) => {
    if (menuKind === "files") {
      const insert = `@${item.path} `;
      const value = `${text.slice(0, mention.start)}${insert}${text.slice(mention.end)}`;
      setText(value);
      setMention(null);
      const caret = mention.start + insert.length;
      setTimeout(() => {
        box.current?.focus();
        box.current?.setSelectionRange(caret, caret);
      }, 0);
      return;
    }
    if (item.session) {
      setText(`/resume ${item.session.id}`);
      setTimeout(() => submitText(`/resume ${item.session.id}`), 0);
      return;
    }
    const parsed = parseSlash(text, catalog);
    const args = parsed?.command?.name === item.name ? parsed.args : "";
    if ((item.needsArgs || /<[^>]+>/.test(item.hint)) && !args) {
      setText(`/${item.name} `);
      setMenuHidden(true);
      box.current?.focus();
      return;
    }
    submitText(args ? `/${item.name} ${args}` : `/${item.name}`);
  };

  const submitText = async (value) => {
    setSending(true);
    try {
      const ok = await onSubmit(value, [], {});
      if (ok !== false) {
        setText("");
        setMenuHidden(false);
      }
    } finally {
      setSending(false);
    }
  };

  const cycleMode = () => {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
    onSettings(next === "plan" ? { mode: "plan" } : { mode: "default", permission: next });
  };

  const onKeyDown = (event) => {
    if (event.nativeEvent.isComposing) return;
    if (items.length && menuKind) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMenuIndex((index) => (index + step + items.length) % items.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuHidden(true);
        setMention(null);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        const parsed = parseSlash(text, catalog);
        const typed = menuKind === "slash" && parsed?.command && parsed.args;
        if (!typed) {
          event.preventDefault();
          pick(items[menuIndex] || items[0]);
          return;
        }
      }
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cycleMode();
      return;
    }
    if (event.key === "ArrowUp" && !text && history.length) {
      event.preventDefault();
      const next = historyAt < 0 ? history.length - 1 : Math.max(0, historyAt - 1);
      setHistoryAt(next);
      setText(history[next]);
      return;
    }
    if (event.key === "ArrowDown" && historyAt >= 0) {
      event.preventDefault();
      const next = historyAt + 1;
      setHistoryAt(next >= history.length ? -1 : next);
      setText(next >= history.length ? "" : history[next]);
      return;
    }
    if (event.key !== "Enter") return;
    if ((event.metaKey || event.ctrlKey) && running) {
      event.preventDefault();
      submit({ now: true });
      return;
    }
    const sends = multiline ? event.shiftKey || event.metaKey || event.ctrlKey : !event.shiftKey;
    if (sends) {
      event.preventDefault();
      submit();
    }
  };

  const currentModel = models.find((item) => item.id === model);
  const effortOptions = efforts?.length ? efforts : currentModel?.efforts || [];
  const modeInfo = MODES[mode] || MODES.ask;
  const empty = !text.trim() && !files.length;

  return (
    <div className="composer-wrap">
      <div
        className="composer"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
        }}
      >
        {menuKind && (
          <div className="suggest" data-testid="command-menu" role="listbox">
            {menuKind === "files" ? items.map((item, index) => (
              <button
                key={item.path}
                type="button"
                role="option"
                aria-selected={index === menuIndex}
                className="suggest-item"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
              >
                <Icon name="file" size={14} />
                <span className="suggest-name">{item.path}</span>
              </button>
            )) : items.map((item, index) => (
              <button
                key={item.session?.id || item.name}
                type="button"
                role="option"
                aria-selected={index === menuIndex}
                className="suggest-item"
                data-testid="command-item"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setMenuIndex(index)}
              >
                <span className="suggest-name">/{item.name}</span>
                {item.hint && <span className="suggest-hint">{item.hint}</span>}
                <span className="suggest-desc">{item.summary}</span>
                {!item.session && <span className={`suggest-source ${item.source}`}>{SOURCE_LABELS[item.source] || item.source}</span>}
              </button>
            ))}
          </div>
        )}
        {queue.length > 0 && (
          <div className="queue" data-testid="queue">
            {queue.map((entry, index) => (
              <div className="queue-item" key={entry.id}>
                <span className="queue-tag">排队 {index + 1}</span>
                <span className="queue-text">{entry.text || "（附件）"}</span>
                <button type="button" className="link" data-testid="queue-now" onClick={() => onQueue(entry.id, "now")}>立即发送</button>
                <button type="button" className="link" data-testid="queue-remove" onClick={() => onQueue(entry.id, "remove")}>移除</button>
              </div>
            ))}
          </div>
        )}
        {(files.length > 0 || fileError) && (
          <div className="attachments">
            {files.map((file, index) => (
              <span className="attachment" data-testid="attachment" key={`${file.name}-${index}`}>
                {file.mimeType.startsWith("image/") ? <img alt="" src={`data:${file.mimeType};base64,${file.data}`} /> : <Icon name="file" size={14} />}
                <span className="attachment-name">{file.name}</span>
                <button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((_, at) => at !== index))}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
            {fileError && <span className="error-text">{fileError}</span>}
          </div>
        )}
        <textarea
          ref={box}
          data-testid="composer"
          rows={1}
          value={text}
          placeholder={running ? "Grok 正在处理，现在发送会排队（Ctrl+Enter 立即发送）" : "发消息或创建任务，/ 调用指令，@ 文件"}
          onChange={(event) => {
            setText(event.target.value);
            setMenuHidden(false);
            setHistoryAt(-1);
            updateMention(event.target.value, event.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
          onPaste={(event) => {
            const pasted = [...(event.clipboardData?.files || [])];
            if (pasted.length) {
              event.preventDefault();
              addFiles(pasted);
            }
          }}
        />
        <div className="composer-bar">
          <input
            ref={picker}
            className="file-input"
            data-testid="file-input"
            type="file"
            multiple
            onChange={(event) => {
              if (event.target.files?.length) addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button type="button" className="round" title="添加图片或文件" data-testid="upload" onClick={() => picker.current?.click()}>
            <Icon name="plus" size={17} />
          </button>
          {draftProject && (
            <button type="button" className="pill" data-testid="draft-project" title={draftProject.cwd} onClick={onPickProject}>
              <Icon name="folder" size={14} />
              <span className="pill-text">{draftProject.name}</span>
              <Icon name="chevronDown" size={13} className="chev" />
            </button>
          )}
          <Popover
            testId="mode-control"
            title="Shift+Tab 切换"
            label={<><Icon name={modeInfo.icon} size={14} /><span className="pill-text">{modeInfo.label}</span></>}
          >
            {(close) => MODE_ORDER.map((key) => (
              <MenuItem
                key={key}
                testId={`mode-${key}`}
                selected={mode === key}
                icon={MODES[key].icon}
                title={MODES[key].label}
                hint={MODES[key].hint}
                onClick={() => {
                  close();
                  onSettings(key === "plan" ? { mode: "plan" } : { mode: "default", permission: key });
                }}
              />
            ))}
          </Popover>
          <span className="spacer" />
          <Popover
            testId="model-control"
            align="right"
            label={<span className="pill-text strong">{model || "模型"}</span>}
          >
            {(close) => models.map((item) => (
              <MenuItem
                key={item.id}
                testId={`model-${item.id}`}
                selected={item.id === model}
                title={item.id}
                hint={item.name && item.name !== item.id && item.name !== "my" ? item.name : ""}
                onClick={() => {
                  close();
                  if (item.id !== model) onSettings({ model: item.id });
                }}
              />
            ))}
          </Popover>
          <Popover
            testId="effort-control"
            align="right"
            disabled={!effortOptions.length}
            label={<><Icon name="gauge" size={14} /><span className="pill-text">{effortLabel(effort)}</span></>}
          >
            {(close) => effortOptions.map((item) => (
              <MenuItem
                key={item.id}
                testId={`effort-${item.id}`}
                selected={item.id === effort}
                title={effortLabel(item.id)}
                hint={item.label}
                onClick={() => {
                  close();
                  if (item.id !== effort) onSettings({ effort: item.id });
                }}
              />
            ))}
          </Popover>
          {(running || busy) && <span className="working" title="Grok 正在处理"><Spinner size={16} /></span>}
          {running && empty ? (
            <button type="button" className="send stop" data-testid="stop" title="停止这一轮" onClick={onStop}>
              <Icon name="stop" size={14} filled />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              data-testid="send"
              title={running ? "排队发送" : "发送"}
              disabled={empty || sending}
              onClick={() => submit()}
            >
              <Icon name="arrowUp" size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function readAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve({ name: file.name, mimeType: file.type || "application/octet-stream", data: result.slice(result.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
