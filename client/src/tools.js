import { shortPath } from "./format.js";

// How tool calls are named and grouped in the transcript, close to the terminal's wording.

const KIND_GROUPS = {
  read: "read",
  search: "search",
  list: "search",
  search_tool: "search",
  execute: "execute",
  edit: "edit",
  write: "edit",
  delete: "edit",
  move: "edit",
  web_search: "web",
  web_fetch: "web",
  fetch: "web",
};

export function toolGroup(tool) {
  if (KIND_GROUPS[tool.kind]) return KIND_GROUPS[tool.kind];
  const name = String(tool.name || "");
  if (/read/.test(name)) return "read";
  if (/grep|search|list|glob|find/.test(name)) return "search";
  if (/terminal|bash|shell|command|exec/.test(name)) return "execute";
  if (/write|edit|replace|patch/.test(name)) return "edit";
  if (/web|fetch|url/.test(name)) return "web";
  return "other";
}

export const GROUP_ICONS = { read: "file", search: "search", execute: "terminal", edit: "pencil", web: "globe", other: "tool" };

export function summarizeTools(tools) {
  const counts = { read: 0, search: 0, execute: 0, edit: 0, web: 0, other: 0 };
  for (const tool of tools) counts[toolGroup(tool)] += 1;
  return [
    counts.read && `读取 ${counts.read} 个文件`,
    counts.search && `搜索 ${counts.search} 次`,
    counts.execute && `执行 ${counts.execute} 条命令`,
    counts.edit && `修改 ${counts.edit} 处`,
    counts.web && `联网 ${counts.web} 次`,
    counts.other && `调用 ${counts.other} 个工具`,
  ].filter(Boolean).join(" · ");
}

export function toolLabel(tool, cwd = "") {
  const input = tool.input && typeof tool.input === "object" ? tool.input : {};
  const at = (value) => shortPath(value || tool.paths?.[0] || "", cwd);
  const quote = (value) => (value ? `“${String(value).slice(0, 80)}”` : "");
  switch (tool.name) {
    case "read_file":
      return `读取 ${at(input.target_file || input.path)}`;
    case "list_dir":
      return `列出 ${at(input.target_directory || input.path) || "目录"}`;
    case "grep":
      return `搜索 ${quote(input.pattern)}${input.path ? ` · ${at(input.path)}` : ""}`;
    case "run_terminal_command":
      return input.command ? `$ ${String(input.command).split("\n")[0].slice(0, 160)}` : "执行命令";
    case "write":
      return `写入 ${at(input.file_path)}`;
    case "search_replace":
    case "edit_file":
      return `编辑 ${at(input.file_path || input.target_file)}`;
    case "web_search":
      return `搜索网页 ${quote(input.query)}`;
    case "web_fetch":
      return `打开 ${input.url || ""}`;
    case "ask_user_question":
      return `向你提问${input.questions?.[0]?.question ? `：${input.questions[0].question}` : ""}`;
    case "exit_plan_mode":
      return "提交计划，等你批准";
    case "enter_plan_mode":
      return "进入计划模式";
    case "todo_write":
      return "更新待办";
    case "get_command_or_subagent_output":
      return "查看后台任务的输出";
    case "kill_command_or_subagent":
      return "结束后台任务";
    case "spawn_subagent":
      return `启动子任务${input.description ? `：${input.description}` : ""}`;
    case "search_tool":
      return `查找工具 ${quote(input.query)}`;
    case "image_gen":
      return "生成图片";
    case "image_edit":
      return "编辑图片";
    default:
      return tool.title || tool.name || "工具";
  }
}

export function statusLabel(status) {
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  return "进行中";
}

export function isRunning(tool) {
  return tool.status !== "completed" && tool.status !== "failed";
}

// Line diff with the common head and tail folded away; enough for the edits Grok makes.
export function lineDiff(oldText, newText, context = 3, limit = 400) {
  const before = String(oldText || "").split("\n");
  const after = String(newText || "").split("\n");
  if (!oldText) return after.slice(0, limit).map((text) => ({ type: "add", text }));
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const rows = [];
  for (let index = Math.max(0, head - context); index < head; index += 1) rows.push({ type: "ctx", text: before[index] });
  for (let index = head; index < before.length - tail; index += 1) rows.push({ type: "del", text: before[index] });
  for (let index = head; index < after.length - tail; index += 1) rows.push({ type: "add", text: after[index] });
  for (let index = after.length - tail; index < Math.min(after.length, after.length - tail + context); index += 1) rows.push({ type: "ctx", text: after[index] });
  return rows.slice(0, limit);
}

export function diffStats(diffs = []) {
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    for (const row of lineDiff(diff.oldText, diff.newText, 0, Infinity)) {
      if (row.type === "add") added += 1;
      if (row.type === "del") removed += 1;
    }
  }
  return { added, removed };
}
