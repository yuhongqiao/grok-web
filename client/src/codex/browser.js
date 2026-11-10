const tools = new Set(["browser_open", "browser_snapshot", "browser_action", "browser_screenshot", "browser_handoff", "browser_tests"]);
export const isBrowserCall = (item) => item.type === "mcpToolCall" && item.server?.startsWith("grok_web_browser_") && tools.has(item.tool);

function browserToolName(tool) {
  const raw = String(tool?.name || tool?.title || "");
  if (tools.has(raw)) return raw;
  const tail = raw.split(/[^A-Za-z0-9_]+/).filter(Boolean).at(-1) || "";
  if (tools.has(tail)) return tail;
  for (const name of tools) if (raw.endsWith(`_${name}`) || raw.endsWith(`/${name}`)) return name;
  return "";
}

// The latest Grok transcript tool that drives the embedded browser, in the shape BrowserSession reads.
export function latestBrowserCall(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = messages[index]?.blocks;
    if (!blocks) continue;
    for (let at = blocks.length - 1; at >= 0; at -= 1) {
      const tool = blocks[at];
      if (tool?.type !== "tool") continue;
      const name = browserToolName(tool);
      if (!name) continue;
      const input = tool.input && typeof tool.input === "object" ? tool.input : {};
      return {
        id: String(tool.id || `${index}-${at}`),
        tool: name,
        status: tool.status === "failed" ? "failed" : tool.status === "completed" ? "completed" : "inProgress",
        arguments: input,
      };
    }
  }
  return null;
}

export function browserLabel(item) {
  const action = item.arguments?.action;
  if (item.tool === "browser_action") return { navigate: "打开页面", click: "点击页面", fill: "填写表单", type: "输入内容", press: "按键操作", select: "选择选项", scroll: "滚动页面", wait: "等待页面", assert: "验证页面", viewport: "调整视口", back: "返回", forward: "前进", reload: "刷新页面", newTab: "打开标签页", tab: "切换标签页", closeTab: "关闭标签页" }[action] || "操作页面";
  return { browser_open: "打开内置浏览器", browser_snapshot: "读取页面", browser_screenshot: "检查页面截图", browser_handoff: "等待你完成登录或验证", browser_tests: action === "run" ? "运行浏览器测试" : "读取浏览器测试" }[item.tool];
}
