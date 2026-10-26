// Slash commands. Web commands run in the page; the rest come from Grok (its built-ins,
// skills and workflows) and are sent to Grok as the prompt text, like the terminal does.

const web = (name, summary, extra = {}) => ({
  name,
  summary,
  source: "web",
  aliases: extra.aliases || [],
  hint: extra.hint || "",
  needsArgs: Boolean(extra.needsArgs),
});

export const WEB_COMMANDS = [
  web("new", "新开会话", { aliases: ["clear"] }),
  web("resume", "打开已有会话", { hint: "[标题]" }),
  web("rename", "重命名当前会话", { aliases: ["title"], hint: "<标题> | --auto", needsArgs: true }),
  web("fork", "从这里分叉出一个新会话"),
  web("rewind", "回退到之前的某一轮", { aliases: ["undo"] }),
  web("btw", "旁问一句，不打断当前任务", { hint: "<问题>", needsArgs: true }),
  web("model", "切换模型", { aliases: ["m"], hint: "<模型>" }),
  web("effort", "设置推理强度", { hint: "low | medium | high | xhigh" }),
  web("plan", "进入计划模式", { hint: "[要做的事]" }),
  web("view-plan", "查看当前计划", { aliases: ["show-plan", "plan-view"] }),
  web("always-approve", "切换全部放行", { aliases: ["yolo"], hint: "[on | off]" }),
  web("auto", "切换自动审批"),
  web("usage", "查看本会话用量和费用", { aliases: ["cost", "session-usage"] }),
  web("skills", "查看技能"),
  web("mcps", "查看 MCP 服务", { aliases: ["mcp"] }),
  web("plugins", "查看插件"),
  web("hooks", "查看钩子"),
  web("memory", "查看记忆", { aliases: ["mem"] }),
  web("copy", "复制最近一条回复", { hint: "[第几条]" }),
  web("export", "导出成 Markdown 文件"),
  web("delete", "删除当前会话（移到回收区）"),
  web("history", "翻看发过的消息"),
  web("multiline", "切换多行输入", { aliases: ["ml"] }),
  web("theme", "切换深色 / 浅色", { aliases: ["t"] }),
  web("settings", "打开设置", { aliases: ["config", "preferences", "prefs"] }),
  web("docs", "打开 Grok Build 文档", { aliases: ["howto", "guides"] }),
  web("help", "列出所有命令"),
  web("home", "回到首页", { aliases: ["welcome", "quit", "exit"] }),
];

// Built-ins of the terminal UI that have nothing to drive in a browser.
export const TERMINAL_ONLY = {
  "vim-mode": "Vim 按键",
  minimal: "精简界面",
  fullscreen: "全屏界面",
  full: "全屏界面",
  density: "工具卡片密度",
  "compact-mode": "紧凑显示",
  "edit-prompt": "外部编辑器",
  find: "滚动搜索（网页里用浏览器的查找）",
  timestamps: "时间戳显示",
  tutorial: "新手引导",
  dashboard: "多会话面板（网页左边栏就是）",
  login: "登录",
  logout: "退出登录",
  privacy: "数据保留设置",
  "release-notes": "更新说明",
  changelog: "更新说明",
  "import-claude": "导入 Claude 设置",
  "config-agents": "智能体管理",
  agents: "智能体管理",
  personas: "人设",
  "context-window": "上下文窗口",
  remember: "记一条笔记",
  flush: "写入记忆",
  dream: "整理记忆",
  doctor: "终端检查",
};

export const SOURCE_LABELS = { web: "网页", grok: "Grok", skill: "技能", workflow: "工作流" };

export function buildCatalog(agentCommands = []) {
  const catalog = [...WEB_COMMANDS];
  const names = new Set(catalog.flatMap((item) => [item.name, ...item.aliases]));
  for (const command of agentCommands || []) {
    const name = String(command?.name || "");
    if (!name || names.has(name)) continue;
    names.add(name);
    catalog.push({
      name,
      summary: command.description || "",
      source: command.source || "grok",
      aliases: [],
      hint: command.hint || "",
      needsArgs: false,
    });
  }
  return catalog;
}

export function findCommand(catalog, name) {
  const needle = String(name || "").toLowerCase();
  return catalog.find((item) => item.name.toLowerCase() === needle || item.aliases.includes(needle)) || null;
}

export function parseSlash(text, catalog) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const body = trimmed.slice(1);
  const splitAt = body.search(/\s/);
  const token = (splitAt === -1 ? body : body.slice(0, splitAt)).toLowerCase();
  if (!token || token.includes("/")) return null;
  const args = splitAt === -1 ? "" : body.slice(splitAt + 1).trim();
  return { token, args, command: findCommand(catalog, token) };
}

export function matchCommands(catalog, query) {
  const needle = String(query || "").replace(/^\//, "").toLowerCase();
  if (!needle) return catalog;
  return catalog
    .map((item) => ({ item, score: score(item, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .map((entry) => entry.item);
}

// What the slash menu shows for the current draft.
export function suggestions(draft, catalog, sessions = []) {
  const value = String(draft || "");
  if (!value.startsWith("/") || value.includes("\n")) return [];
  const parsed = parseSlash(value, catalog);
  if (!parsed && value !== "/") return [];
  if (value === "/" || !/\s/.test(value)) return matchCommands(catalog, parsed?.token || "").slice(0, 60);
  if (parsed?.command?.name === "resume") {
    const needle = parsed.args.toLowerCase();
    return sessions
      .filter((session) => !needle || session.title.toLowerCase().includes(needle) || session.id.startsWith(needle))
      .slice(0, 12)
      .map((session) => ({ name: "resume", summary: session.title, source: "web", aliases: [], hint: "", session }));
  }
  return [];
}

function score(item, needle) {
  let best = 0;
  for (const name of [item.name, ...item.aliases]) {
    const lower = name.toLowerCase();
    if (lower === needle) best = Math.max(best, 1000);
    else if (lower.startsWith(needle)) best = Math.max(best, 800 - lower.length);
    else if (lower.includes(needle)) best = Math.max(best, 500 - lower.length);
    else if (fuzzy(lower, needle)) best = Math.max(best, 300 - lower.length);
  }
  if (item.summary.toLowerCase().includes(needle)) best = Math.max(best, 50);
  return best;
}

function fuzzy(name, needle) {
  let index = 0;
  for (const char of name) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}
