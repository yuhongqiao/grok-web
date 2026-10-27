import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { randomBytes } from "node:crypto";
import { startAgent } from "./agent.js";
import { createHub } from "./hub.js";
import { createCodexHub, mountCodexRoutes } from "./codex.js";
import { createCodexWorkspace, mountWorkspaceRoutes } from "./codex-workspace.js";
import { createBrowserLab, mountBrowserRoutes } from "./codex-browser.js";
import { HttpError, createStore, defaultPaths } from "./sessions.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "client", "dist");
const HOST = "127.0.0.1";
const DEFAULT_PORT = 3090;
const DEV_PORT = 5173;
const LOOPBACK = new Set(["127.0.0.1", "::ffff:127.0.0.1", "::1"]);

// Only this machine may use the server: it starts Grok sessions that can run commands.
// The Host header has to name 127.0.0.1 or localhost (a rebound DNS name is refused), and a
// browser Origin, when there is one, has to be this page or the `npm run dev` page.
export function localOnly(req, res, next) {
  const port = req.socket.localPort;
  const host = String(req.headers.host || "").toLowerCase();
  const origin = req.headers.origin;
  const allowedOrigins = [port, DEV_PORT].flatMap((item) => [`http://127.0.0.1:${item}`, `http://localhost:${item}`]);
  if (!LOOPBACK.has(req.socket.remoteAddress) || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || (origin && !allowedOrigins.includes(origin))) {
    res.status(403).json({ error: "只接受本机 127.0.0.1 的访问" });
    return;
  }
  next();
}

export function createApp({ store, hub, codex, workspace, browser, browserToken }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(localOnly);
  app.use(express.json({ limit: "100mb" }));

  const route = (handler, status = 200) => async (req, res, next) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.status(status).json(result ?? { ok: true });
    } catch (error) {
      next(error);
    }
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  if (codex) mountCodexRoutes(app, codex, route);
  if (workspace) mountWorkspaceRoutes(app, workspace, route);
  if (browser) mountBrowserRoutes(app, browser, route, browserToken);

  app.get("/api/state", route(() => ({ ...store.listState(), defaults: hub.defaults(), live: hub.live() })));
  app.post("/api/projects", route((req) => store.createProject(req.body || {}), 201));
  app.delete("/api/projects/:encoded", route((req) => store.removeProject(req.params.encoded)));
  app.get("/api/projects/:encoded/files", route((req) => ({ files: store.searchFiles(req.params.encoded, req.query.q) })));
  app.post("/api/projects/:encoded/sessions", route((req) => hub.create(req.params.encoded, req.body || {}), 201));

  // Server-sent events: one snapshot, then every change of this session.
  app.get("/api/sessions/:id/events", (req, res, next) => {
    let snapshot;
    try {
      snapshot = hub.snapshot(req.params.id);
    } catch (error) {
      next(error);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "snapshot", ...snapshot });
    const unwatch = hub.watch(req.params.id, send);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      unwatch();
      clearInterval(ping);
    });
  });

  app.post("/api/sessions/:id/prompt", route((req) => hub.prompt(req.params.id, req.body || {})));
  app.post("/api/sessions/:id/cancel", route((req) => hub.cancel(req.params.id)));
  app.post("/api/sessions/:id/queue/:entryId", route((req) => hub.queueAction(req.params.id, req.params.entryId, req.body?.action)));
  app.post("/api/sessions/:id/interactions/:requestId", route((req) => hub.answer(req.params.id, req.params.requestId, req.body || {})));
  app.post("/api/sessions/:id/settings", route((req) => hub.settings(req.params.id, req.body || {})));
  app.patch("/api/sessions/:id", route((req) => hub.rename(req.params.id, req.body || {})));
  app.delete("/api/sessions/:id", route((req) => hub.trash(req.params.id)));
  app.get("/api/sessions/:id/turns", route((req) => hub.turns(req.params.id)));
  app.post("/api/sessions/:id/rewind", route((req) => hub.rewind(req.params.id, req.body || {})));
  app.post("/api/sessions/:id/fork", route((req) => hub.fork(req.params.id, req.body || {})));
  app.post("/api/sessions/:id/btw", route((req) => hub.btw(req.params.id, req.body?.question)));
  app.get("/api/sessions/:id/plan", route((req) => hub.plan(req.params.id)));
  app.get("/api/extensions/:kind", route((req) => hub.extensions(req.params.kind, {
    sessionId: req.query.session ? String(req.query.session) : "",
    encoded: req.query.project ? String(req.query.project) : "",
  })));

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "没有这个接口")));

  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== "GET") return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  app.use((error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : error.type === "entity.too.large" ? 413 : 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) res.status(status).json({ error: error.message || "服务器错误" });
    else res.end();
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const store = createStore(defaultPaths(root));
  const hub = createHub({ store, spawnAgent: () => startAgent() });
  const codex = createCodexHub({ projectsFile: path.join(root, "data", "codex-projects.json") });
  const workspace = createCodexWorkspace(codex);
  const browser = createBrowserLab({ dataDir: path.join(root, "data", "codex-browser") });
  const browserToken = randomBytes(32).toString("hex");
  hub.start();
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = createApp({ store, hub, codex, workspace, browser, browserToken }).listen(port, HOST, () => {
    codex.configureBrowser({ name: `grok_web_browser_${process.pid}_${randomBytes(4).toString("hex")}`, script: path.join(root, "server", "browser-mcp.js"), url: `http://${HOST}:${server.address().port}/api/codex/browser/mcp`, token: browserToken });
    console.log(`grok-web listening on http://${HOST}:${port}`);
  });
  const shutdown = async () => {
    setTimeout(() => process.exit(0), 5000).unref();
    hub.stop();
    workspace.close();
    codex.stop();
    await browser.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
