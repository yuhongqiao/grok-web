const tools = new Set(["browser_open", "browser_snapshot", "browser_action", "browser_screenshot", "browser_handoff", "browser_tests"]);
export const isBrowserCall = (item) => item.type === "mcpToolCall" && item.server?.startsWith("grok_web_browser_") && tools.has(item.tool);

export function browserLabel(item) {
  const action = item.arguments?.action;
  if (item.tool === "browser_action") return { navigate: "打开页面", click: "点击页面", fill: "填写表单", type: "输入内容", press: "按键操作", select: "选择选项", scroll: "滚动页面", wait: "等待页面", assert: "验证页面", viewport: "调整视口", back: "返回", forward: "前进", reload: "刷新页面", newTab: "打开标签页", tab: "切换标签页", closeTab: "关闭标签页" }[action] || "操作页面";
  return { browser_open: "打开内置浏览器", browser_snapshot: "读取页面", browser_screenshot: "检查页面截图", browser_handoff: "等待你完成登录或验证", browser_tests: action === "run" ? "运行浏览器测试" : "读取浏览器测试" }[item.tool];
}
