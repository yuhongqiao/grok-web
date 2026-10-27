import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Codex app-server uses newline-delimited JSON-RPC, independently of Grok's ACP.
export function startCodexAgent(options = {}) {
  const command = options.command || process.env.CODEX_AGENT_COMMAND || "codex";
  const args = [...(options.args || ["app-server", "--listen", "stdio://"])];
  // Process-only MCP additions preserve the user's CLI config and existing servers.
  if (options.browserBridge) {
    const { name, script, url, token } = options.browserBridge;
    args.push("-c", `mcp_servers.${name}.command=${JSON.stringify(process.execPath)}`,
      "-c", `mcp_servers.${name}.tool_timeout_sec=360`,
      "-c", `mcp_servers.${name}.args=${JSON.stringify([script])}`,
      "-c", `mcp_servers.${name}.env={CODEX_WEB_BROWSER_URL=${JSON.stringify(url)},CODEX_WEB_BROWSER_TOKEN=${JSON.stringify(token)}}`);
  }
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"], env: options.env || process.env,
  });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  let stopped = false;
  let failure = "";
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => {});

  function write(message) {
    if (stopped || !child.stdin.writable) throw new Error(failure || "Codex 进程已退出");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function rejectPending(reason) {
    failure = reason;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method) {
      for (const listener of listeners) listener(message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(message.error.message || "Codex 请求失败");
      error.code = message.error.code;
      entry.reject(error);
    } else entry.resolve(message.result);
  });
  child.on("error", (error) => rejectPending(`无法启动 Codex：${error.message}`));
  const exited = new Promise((resolve) => child.once("close", (code) => {
    stopped = true;
    lines.close();
    rejectPending(failure || `Codex 进程已退出（${code ?? "未知"}）`);
    resolve(code);
  }));

  const agent = {
    exited,
    get alive() { return !stopped; },
    request(method, params = {}, timeout = 60_000) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex ${method} 超时`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        try { write({ id, method, params }); } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    respond(id, result) { write({ id, result }); },
    respondError(id, message) { write({ id, error: { code: -32601, message } }); },
    subscribe(listener) { listeners.add(listener); },
    stop() {
      if (stopped) return;
      stopped = true;
      rejectPending("Codex 连接已关闭");
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      timer.unref();
      exited.then(() => clearTimeout(timer));
    },
  };
  agent.ready = agent.request("initialize", {
    clientInfo: { name: "grok_web_codex", title: "Codex Web", version: "0.2.0" },
    capabilities: { experimentalApi: true },
  }).then((result) => {
    write({ method: "initialized", params: {} });
    return result;
  }, (error) => { agent.stop(); throw error; });
  agent.ready.catch(() => {});
  return agent;
}
