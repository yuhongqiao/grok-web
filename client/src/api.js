async function call(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

const session = (id, rest = "") => `/api/sessions/${encodeURIComponent(id)}${rest}`;

export const api = {
  state: () => call("GET", "/api/state"),
  createProject: (body) => call("POST", "/api/projects", body),
  removeProject: (encoded) => call("DELETE", `/api/projects/${encodeURIComponent(encoded)}`),
  files: (encoded, query) => call("GET", `/api/projects/${encodeURIComponent(encoded)}/files?q=${encodeURIComponent(query)}`),
  createSession: (encoded, body) => call("POST", `/api/projects/${encodeURIComponent(encoded)}/sessions`, body),
  prompt: (id, body) => call("POST", session(id, "/prompt"), body),
  cancel: (id) => call("POST", session(id, "/cancel"), {}),
  queue: (id, entryId, action) => call("POST", session(id, `/queue/${encodeURIComponent(entryId)}`), { action }),
  answer: (id, requestId, body) => call("POST", session(id, `/interactions/${encodeURIComponent(requestId)}`), body),
  settings: (id, body) => call("POST", session(id, "/settings"), body),
  rename: (id, body) => call("PATCH", session(id), body),
  trash: (id) => call("DELETE", session(id)),
  turns: (id) => call("GET", session(id, "/turns")),
  rewind: (id, body) => call("POST", session(id, "/rewind"), body),
  fork: (id, body) => call("POST", session(id, "/fork"), body),
  btw: (id, question) => call("POST", session(id, "/btw"), { question }),
  plan: (id) => call("GET", session(id, "/plan")),
  extensions: (kind, params) => call("GET", `/api/extensions/${kind}?${new URLSearchParams(params)}`),
};

// Events of one session. EventSource reconnects by itself and then gets a fresh snapshot.
export function streamSession(id, onEvent, onFail) {
  const source = new EventSource(session(id, "/events"));
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch (error) {
      console.error(error);
    }
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onFail?.();
  };
  return () => source.close();
}
