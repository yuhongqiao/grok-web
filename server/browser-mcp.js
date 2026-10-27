// Native CLI MCP transport. It only forwards browser tools to this web process;
// it does not edit CLI configuration or replace native CLI tools.
import { createInterface } from "node:readline";
import { browserTools } from "./codex-browser.js";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codex-web-browser", version: "1.1.0" }, instructions: "This server provides the browser embedded in the user's Codex Web conversation. For requests to log in or test pages in this web client's embedded browser, use browser_open, browser_snapshot and browser_action from this server. Its live preview appears automatically beside the conversation. This web client does not host the Codex desktop iab browser; cua_repl iab tabs belong to the desktop host and are unavailable here. Existing CLI tools and plugins remain available for their own tasks. Use browser_handoff when the user needs to enter credentials or complete verification, then continue checking the page when control is returned." };
    else if (message.method === "ping") result = {};
    else if (message.method === "tools/list") result = { tools: browserTools };
    else if (message.method === "tools/call") {
      try {
        const response = await fetch(process.env.CODEX_WEB_BROWSER_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CODEX_WEB_BROWSER_TOKEN}` }, body: JSON.stringify(message.params), signal: AbortSignal.timeout(330_000) });
        const value = await response.json();
        result = response.ok ? value : { isError: true, content: [{ type: "text", text: value.error || "Browser operation failed" }] };
      } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
    } else { send({ id: message.id, error: { code: -32601, message: "Unsupported MCP method" } }); return; }
    send({ id: message.id, result });
  } catch (error) { send({ id: message.id, error: { code: -32603, message: error.message } }); }
});
