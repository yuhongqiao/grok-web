import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildPrompt, mentions } from "../server/prompt.js";
import { tempRoot } from "./helpers.js";

test("buildPrompt sends images as images and text files as text", () => {
  const blocks = buildPrompt("看一下", [
    { name: "dot.png", mimeType: "image/png", data: Buffer.from("png").toString("base64") },
    { name: "note.txt", mimeType: "text/plain", data: Buffer.from("正文").toString("base64") },
    { name: "blob.bin", mimeType: "application/octet-stream", data: Buffer.from([0, 1, 2, 3]).toString("base64") },
  ]);
  assert.equal(blocks[0].text, "看一下");
  assert.equal(blocks[1].type, "image");
  assert.equal(blocks[1].mimeType, "image/png");
  assert.equal(blocks[2].resource.text, "正文");
  assert.equal(typeof blocks[3].resource.blob, "string");
});

test("@path mentions of existing files become resource links", () => {
  const cwd = tempRoot();
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "app.js"), "x");
  assert.deepEqual(mentions("看 @src/app.js，还有 @所有人 和 @nope.js", cwd), [path.join(cwd, "src", "app.js")]);
  const blocks = buildPrompt("看 @src/app.js", [], { cwd });
  assert.equal(blocks[1].type, "resource_link");
  assert.equal(blocks[1].name, "app.js");
  assert.equal(blocks[1].uri.startsWith("file://"), true);
});

test("buildPrompt rejects an empty message and a huge file", () => {
  assert.throws(() => buildPrompt("  ", []), /消息不能为空/);
  assert.throws(() => buildPrompt("", [{ name: "big.bin", mimeType: "application/octet-stream", data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") }]), /8MB/);
  assert.throws(() => buildPrompt("", [{ name: "a.svg", mimeType: "image/svg+xml", data: "AAAA" }]), /先不支持/);
});
