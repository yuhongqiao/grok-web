export function threadTitle(thread) {
  return thread?.name || thread?.preview?.slice(0, 80) || "新会话";
}

export function runningTurn(thread) {
  return thread?.turns?.findLast((turn) => turn.status === "inProgress") || null;
}

function mergeItems(previous, items) {
  const result = [...previous];
  for (const item of items) {
    const index = result.findIndex((entry) => entry.id === item.id);
    if (index < 0) result.push(item);
    else result[index] = { ...result[index], ...item };
  }
  return result;
}

// Used by the server's reconnect snapshot and the browser's live stream alike.
export function applyThreadEvent(thread, { method, params: p = {} }) {
  if (!thread || (p.threadId && p.threadId !== thread.id)) return thread;
  if (method === "thread/status/changed") return { ...thread, status: p.status };
  if (method === "thread/name/updated") return { ...thread, name: p.threadName };
  if (method === "thread/tokenUsage/updated") return { ...thread, tokenUsage: p.tokenUsage };
  if (method === "error") return { ...thread, error: p.error?.message || "Codex 请求失败" };

  const turnId = p.turnId || p.turn?.id;
  if (!turnId) return thread;
  const turns = [...(thread.turns || [])];
  let index = turns.findIndex((entry) => entry.id === turnId);
  if (index < 0) {
    index = turns.length;
    turns.push({ id: turnId, status: "inProgress", items: [] });
  }
  let turn = { ...turns[index] };
  if (method === "turn/started" || method === "turn/completed") {
    // A fast turn may finish before the turn/start RPC response reaches us.
    if (method === "turn/started" && turn.status !== "inProgress") return thread;
    turn = { ...turn, ...p.turn, items: mergeItems(turn.items, p.turn.items || []) };
  } else if (method === "item/started" || method === "item/completed") {
    turn.items = mergeItems(turn.items, [p.item]);
  } else if (method === "turn/plan/updated") {
    turn.plan = p.plan;
    turn.explanation = p.explanation;
  } else if (method === "turn/diff/updated") {
    turn.diff = p.diff;
  } else {
    const deltaTypes = {
      "item/agentMessage/delta": ["agentMessage", "text"],
      "item/plan/delta": ["plan", "text"],
      "item/commandExecution/outputDelta": ["commandExecution", "aggregatedOutput"],
      "item/reasoning/summaryTextDelta": ["reasoning", "summary"],
    };
    const type = deltaTypes[method];
    if (!type || !p.itemId) return thread;
    const item = { ...(turn.items.find((entry) => entry.id === p.itemId) || { id: p.itemId, type: type[0] }) };
    if (type[1] === "summary") {
      item.summary = [...(item.summary || [])];
      item.summary[p.summaryIndex] = (item.summary[p.summaryIndex] || "") + p.delta;
    } else item[type[1]] = (item[type[1]] || "") + p.delta;
    turn.items = mergeItems(turn.items, [item]);
  }
  turns[index] = turn;
  return {
    ...thread, turns,
    ...(method === "item/completed" && p.item?.type === "userMessage" && !thread.preview ? { preview: p.item.content?.find((part) => part.type === "text")?.text?.slice(0, 200) || "" } : {}),
    ...(method === "turn/started" ? { error: null, status: { type: "active" } } : {}),
    ...(method === "turn/completed" ? { status: { type: "idle" } } : {}),
  };
}
