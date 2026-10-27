import path from "node:path";
import fs from "node:fs";
import { HttpError } from "./sessions.js";
import { mentions } from "./prompt.js";

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/javascript", "application/x-sh", "application/sql"]);

export function codexInput(body, cwd) {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const input = text ? [{ type: "text", text }] : [];
  for (const file of mentions(text, cwd)) input.push({ type: "mention", name: path.basename(file), path: file });
  for (const match of text.matchAll(/(?:^|\s)@"([^"\r\n]+)"/g)) {
    const file = path.resolve(cwd, match[1]);
    try { if (fs.statSync(file).isFile() && !input.some((part) => part.path === file)) input.push({ type: "mention", name: path.basename(file), path: file }); } catch {}
  }
  const attachments = body.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 8) throw new HttpError(400, "一次最多 8 个附件");
  for (const file of attachments) {
    const name = path.basename(String(file?.name || "附件")).replace(/[\r\n]/g, "").slice(0, 180);
    const mime = String(file?.mimeType || "application/octet-stream");
    const data = typeof file?.data === "string" ? file.data : "";
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== data) throw new HttpError(400, `${name} 内容无效或超过 8MB`);
    if (IMAGES.has(mime)) {
      input.push({ type: "image", url: `data:${mime};base64,${data}` });
    } else {
      if (mime !== "application/octet-stream" && !mime.startsWith("text/") && !TEXT_TYPES.has(mime) && !mime.endsWith("+json") && !mime.endsWith("+xml")) throw new HttpError(400, `${name} 暂不支持，请添加图片或 UTF-8 文本文件`);
      let content;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new HttpError(400, `${name} 不是 UTF-8 文本`); }
      if (content.includes("\0") || /\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(name)) throw new HttpError(400, `${name} 暂不支持，请添加图片或 UTF-8 文本文件`);
      input.push({ type: "text", text: `附件：${name}\n${content}` });
    }
  }
  if (!input.length) throw new HttpError(400, "请输入消息或添加附件");
  return input;
}
