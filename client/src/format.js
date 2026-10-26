export const EFFORT_LABELS = { minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };

export const MODES = {
  ask: { label: "询问", hint: "改文件、跑命令前先问你", icon: "shield" },
  plan: { label: "计划模式", hint: "只读代码和写计划，你批准后才动手", icon: "map" },
  auto: { label: "自动审批", hint: "安全的操作自动放行，其余再问你", icon: "bot" },
  yolo: { label: "全部放行", hint: "所有操作直接执行，不再询问", icon: "zap" },
};

export const MODE_ORDER = ["ask", "plan", "auto", "yolo"];

export function modeKey(mode, permission) {
  return mode === "plan" ? "plan" : MODES[permission] ? permission : "ask";
}

export function effortLabel(id) {
  return EFFORT_LABELS[id] || id || "默认";
}

export function tokens(value) {
  const number = Number(value) || 0;
  if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)}K`;
  return String(number);
}

export function duration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

export function money(usd) {
  const value = Number(usd) || 0;
  if (!value) return "$0";
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

export function ago(value) {
  const time = new Date(value).getTime();
  if (!time) return "";
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月`;
  return `${Math.floor(months / 12)}年`;
}

export function stamp(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return time;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}年${day} ${time}`;
}

export function shortPath(file, cwd) {
  const value = String(file || "");
  if (cwd && value.startsWith(`${cwd}/`)) return value.slice(cwd.length + 1);
  const home = value.match(/^\/Users\/[^/]+\//);
  return home ? `~/${value.slice(home[0].length)}` : value;
}
