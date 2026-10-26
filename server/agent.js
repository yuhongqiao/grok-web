import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60_000;

// JSON-RPC over the stdio of `grok agent stdio`. Notifications and requests from Grok go to
// subscribers; the hub answers Grok's requests with respond().
export function startAgent(options = {}) {
  const command = options.command || process.env.GROK_AGENT_COMMAND || "grok";
  const args = options.args || (process.env.GROK_AGENT_ARGS ? JSON.parse(process.env.GROK_AGENT_ARGS) : ["agent", "stdio"]);
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: options.env || process.env });
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let stopped = false;
  const pending = new Map();
  const listeners = new Set();

  const write = (message) => {
    if (stopped || !child.stdin.writable) throw new Error("Grok 进程已退出");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const onLine = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.method) {
      for (const listener of listeners) {
        try {
          listener(message);
        } catch (error) {
          console.error(error);
        }
      }
      return;
    }
    if (message?.id === undefined) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(rpcError(message.error));
    else item.resolve(message.result);
  };

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    stderr = `${stderr}\n${error.message}`.trim();
  });

  const exited = new Promise((resolve) => child.once("exit", resolve));
  exited.then((code) => {
    stopped = true;
    const error = new Error(lastLine(stderr) || `Grok 进程已退出（${code ?? "未知"}）`);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  });

  const agent = {
    pid: child.pid,
    exited,
    info: null,
    get alive() {
      return !stopped;
    },
    stderrTail: () => lastLine(stderr),
    request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
      if (stopped) return Promise.reject(new Error(lastLine(stderr) || "Grok 进程已退出"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs
          ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} 超时`));
          }, timeoutMs)
          : null;
        pending.set(id, { resolve, reject, timer });
        try {
          write({ jsonrpc: "2.0", id, method, params: params ?? {} });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params: params ?? {} });
    },
    respond(id, result) {
      write({ jsonrpc: "2.0", id, result });
    },
    respondError(id, code, message) {
      write({ jsonrpc: "2.0", id, error: { code, message } });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
    },
  };

  agent.ready = agent.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "grok-web", version: "0.2.0" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }, 60_000).then((result) => {
    agent.info = result || {};
    return agent.info;
  }, (error) => {
    agent.stop();
    throw error;
  });
  agent.ready.catch(() => {});

  return agent;
}

function rpcError(error) {
  const data = typeof error?.data === "string" ? error.data : error?.data?.uri || "";
  const result = new Error(data ? `${error.message}: ${data}` : error?.message || "Grok 请求失败");
  result.code = error?.code;
  return result;
}

function lastLine(text) {
  return String(text || "").trim().split("\n").filter((line) => !/new version of Grok Build/i.test(line)).at(-1) || "";
}
