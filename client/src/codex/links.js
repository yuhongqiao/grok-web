export function threadLocation() {
  const match = window.location.hash.match(/^#\/t\/([^/]+)(?:\/turn\/([^/]+))?$/);
  try { return { id: match ? decodeURIComponent(match[1]) : "", turnId: match?.[2] ? decodeURIComponent(match[2]) : "" }; }
  catch { return { id: "", turnId: "" }; }
}

export function threadLink(id, turnId) {
  const url = new URL(window.location.href);
  url.hash = `/t/${encodeURIComponent(id)}${turnId ? `/turn/${encodeURIComponent(turnId)}` : ""}`;
  return url.href;
}

export function resumeCommand(cwd, id) {
  const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
  return `codex -C ${quote(cwd)} resume ${quote(id)}`;
}
