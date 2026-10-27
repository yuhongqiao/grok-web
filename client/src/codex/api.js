async function call(method, url, body) {
  const response = await fetch(`/api/codex${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Codex 请求失败");
  return data;
}

const thread = (id, rest = "") => `/threads/${encodeURIComponent(id)}${rest}`;
export const codexApi = {
  state: () => call("GET", "/state"),
  permissions: (cwd) => call("GET", `/permissions?cwd=${encodeURIComponent(cwd)}`),
  threads: (cursor = "", archived = false, query = "") => call("GET", `/threads?cursor=${encodeURIComponent(cursor || "")}&archived=${archived}&q=${encodeURIComponent(query)}`),
  skills: (cwd, refresh = false) => call("GET", `/skills?cwd=${encodeURIComponent(cwd)}&refresh=${refresh}`),
  skillConfig: (cwd, path, enabled) => call("PATCH", "/skills", { cwd, path, enabled }),
  files: (cwd, query) => call("GET", `/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`),
  addProject: (cwd) => call("POST", "/projects", { cwd }),
  create: (body) => call("POST", "/threads", body),
  prompt: (id, body) => call("POST", thread(id, "/prompt"), body),
  cancel: (id) => call("POST", thread(id, "/cancel"), {}),
  answer: (id, requestId, body) => call("POST", thread(id, `/interactions/${encodeURIComponent(requestId)}`), body),
  rename: (id, name) => call("PATCH", thread(id), { name }),
  archive: (id) => call("DELETE", thread(id)),
  restore: (id) => call("POST", thread(id, "/restore"), {}),
  fork: (id, lastTurnId) => call("POST", thread(id, "/fork"), { lastTurnId }),
  compact: (id) => call("POST", thread(id, "/compact"), {}),
  revise: (id, turnId, body) => call("POST", thread(id, `/turns/${encodeURIComponent(turnId)}/revise`), body),
  settings: (id, body) => call("PATCH", thread(id, "/settings"), body),
  review: (id, target) => call("POST", thread(id, "/review"), { target }),
  queue: (id, entryId, action, expectedTurnId, text) => call("POST", thread(id, `/queue/${encodeURIComponent(entryId)}`), { action, expectedTurnId, text }),
};

const query = (values) => new URLSearchParams(values).toString();
export const workspaceApi = {
  tree: (cwd, path = "") => call("GET", `/workspace/tree?${query({ cwd, path })}`),
  read: (cwd, path) => call("GET", `/workspace/file?${query({ cwd, path })}`),
  save: (cwd, file) => call("PUT", "/workspace/file", { cwd, ...file }),
  git: (cwd) => call("GET", `/workspace/git?${query({ cwd })}`),
  gitAction: (cwd, action, body = {}) => call("POST", `/workspace/git/${action}`, { cwd, ...body }),
  scripts: (cwd) => call("GET", `/workspace/scripts?${query({ cwd })}`),
  start: (cwd, body) => call("POST", "/workspace/processes", { cwd, ...body }),
  process: (cwd, id, action, body = {}) => call("POST", `/workspace/processes/${encodeURIComponent(id)}/${action}`, { cwd, ...body }),
  watch: (cwd, onEvent, onError) => {
    const source = new EventSource(`/api/codex/workspace/events?${query({ cwd })}`);
    source.onmessage = (event) => onEvent(JSON.parse(event.data));
    source.onerror = () => onError("终端连接断开，正在重新连接…");
    return () => source.close();
  },
};

export const browserApi = {
  get: (action, cwd, profile) => call("GET", `/browser/${action}?${query({ cwd, profile })}`),
  post: (action, cwd, profile, body = {}) => call("POST", `/browser/${action}`, { cwd, profile, ...body }),
  artifact: (cwd, profile, id, file = "report.json") => `/api/codex/browser/reports/${encodeURIComponent(id)}/${encodeURIComponent(file)}?${query({ cwd, profile })}`,
};

export function streamThread(id, onEvent, onError) {
  const source = new EventSource(`/api/codex${thread(id, "/events")}`);
  source.onmessage = (event) => onEvent(JSON.parse(event.data));
  source.onerror = () => onError(source.readyState === EventSource.CLOSED);
  return () => source.close();
}
