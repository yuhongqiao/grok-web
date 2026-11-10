// Text parts that carry a file. The marker is stored with the message, so later
// edits can tell an attachment from a user sentence that happens to start the same way.
const MARK = "[[grok-web-attachment:";

export function attachmentText(name, content) {
  return `${MARK}${encodeURIComponent(name)}]]\n${content}`;
}

export function attachmentParts(text) {
  if (typeof text !== "string") return null;
  if (text.startsWith(MARK)) {
    const end = text.indexOf("]]\n");
    if (end < 0) return null;
    let name = text.slice(MARK.length, end);
    try { name = decodeURIComponent(name); } catch { return null; }
    return { name, content: text.slice(end + 3) };
  }
  // Older builds stored `附件：name\ncontent`. A sentence with no newline is user text.
  const legacy = text.match(/^附件：([^\r\n/\\]{1,180})\n([\s\S]*)$/);
  if (!legacy) return null;
  return { name: legacy[1], content: legacy[2] };
}
