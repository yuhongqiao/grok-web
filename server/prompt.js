import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HttpError } from "./sessions.js";

const MAX_FILES = 8;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MENTIONS = 20;
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// ACP prompt blocks: the text, `@path` mentions as resource links, then the attachments.
export function buildPrompt(text, attachments = [], { cwd = "" } = {}) {
  if (!Array.isArray(attachments)) throw new HttpError(400, "附件格式不对");
  if (attachments.length > MAX_FILES) throw new HttpError(400, "一次最多 8 个附件");
  const blocks = [];
  const trimmed = String(text || "").trim();
  if (trimmed) blocks.push({ type: "text", text: trimmed });
  for (const file of mentions(trimmed, cwd)) {
    blocks.push({ type: "resource_link", uri: pathToFileURL(file).href, name: path.basename(file) });
  }

  for (const file of attachments) {
    const name = safeName(file?.name);
    const mimeType = String(file?.mimeType || "application/octet-stream").slice(0, 120);
    const data = String(file?.data || "").replace(/\s/g, "");
    if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, `${name} 的内容无效`);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new HttpError(400, `${name} 为空或超过 8MB`);
    if (mimeType.startsWith("image/")) {
      if (!IMAGES.has(mimeType)) throw new HttpError(400, `${name} 这种图片先不支持`);
      blocks.push({ type: "image", mimeType, data });
      continue;
    }
    const uri = `attachment:///${encodeURIComponent(name)}`;
    blocks.push(looksLikeText(bytes, mimeType)
      ? { type: "resource", resource: { uri, mimeType: mimeType.startsWith("text/") ? mimeType : "text/plain", text: bytes.toString("utf8") } }
      : { type: "resource", resource: { uri, mimeType, blob: data } });
  }

  if (blocks.length === 0) throw new HttpError(400, "消息不能为空");
  return blocks;
}

// Existing files named as `@path`, and only when they stay inside the project.
export function mentions(text, cwd) {
  const found = [];
  const pattern = /(^|\s)@([^\s@，。；：！？、（）【】「」《》"'`]+)/gu;
  let match = pattern.exec(text);
  while (match && found.length < MAX_MENTIONS) {
    const raw = match[2].replace(/[,.;:)\]]+$/, "");
    const file = cwd ? path.resolve(cwd, raw) : "";
    if (file && !found.includes(file) && withinProject(cwd, file) && isFile(file)) found.push(file);
    match = pattern.exec(text);
  }
  return found;
}

// True when `file` is a real path inside `cwd`, after resolving `..` and links.
export function withinProject(cwd, file) {
  if (!cwd || !file) return false;
  const root = path.resolve(cwd);
  const target = path.resolve(root, file);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    const realRel = path.relative(realRoot, realTarget);
    return Boolean(realRel) && !realRel.startsWith("..") && !path.isAbsolute(realRel);
  } catch {
    return false;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function safeName(name) {
  const base = path.basename(String(name || "附件")).replace(/[\r\n]/g, "");
  if (!base || base === "." || base === "..") return "附件";
  return base.slice(0, 180);
}

function looksLikeText(bytes, mimeType) {
  if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json") || mimeType.endsWith("+xml")) return true;
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/") || mimeType.startsWith("image/")) return false;
  return !bytes.subarray(0, 8000).includes(0);
}
