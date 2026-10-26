import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, findCommand, matchCommands, parseSlash, suggestions } from "../client/src/commands.js";

const agentCommands = [
  { name: "compact", description: "Compress conversation history", hint: "", source: "grok" },
  { name: "always-approve", description: "Toggle always-approve", hint: "on|off", source: "grok" },
  { name: "code-review", description: "Strict review", hint: "", source: "skill" },
];

test("the catalog puts web commands first and adds Grok's own without duplicates", () => {
  const catalog = buildCatalog(agentCommands);
  assert.equal(catalog.filter((item) => item.name === "always-approve").length, 1);
  assert.equal(findCommand(catalog, "always-approve").source, "web");
  assert.equal(findCommand(catalog, "compact").source, "grok");
  assert.equal(findCommand(catalog, "code-review").source, "skill");
  assert.equal(findCommand(catalog, "ml").name, "multiline");
  assert.equal(findCommand(catalog, "undo").name, "rewind");
});

test("parseSlash splits the command and leaves paths alone", () => {
  const catalog = buildCatalog(agentCommands);
  assert.equal(parseSlash("你好", catalog), null);
  assert.equal(parseSlash("/tmp/a.txt 有问题", catalog), null);
  const parsed = parseSlash("/model grok-4.6", catalog);
  assert.equal(parsed.command.name, "model");
  assert.equal(parsed.args, "grok-4.6");
  assert.equal(parseSlash("/zzz", catalog).command, null);
  assert.equal(parseSlash("/rename --auto", catalog).args, "--auto");
});

test("the menu fuzzy-matches and /resume lists sessions", () => {
  const catalog = buildCatalog(agentCommands);
  assert.equal(matchCommands(catalog, "ren")[0].name, "rename");
  assert.equal(matchCommands(catalog, "code")[0].name, "code-review");
  assert.equal(suggestions("/", catalog).length > 20, true);
  assert.equal(suggestions("你好 /", catalog).length, 0);
  const sessions = [{ id: "01a1", title: "引体向上" }, { id: "01a2", title: "改稿" }];
  const hits = suggestions("/resume 引体", catalog, sessions);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session.title, "引体向上");
});
