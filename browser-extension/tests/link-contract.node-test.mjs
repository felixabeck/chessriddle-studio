// The extension's half of ../link-contract.json. The desktop app's half is the parser test in
// src-tauri/src/infra/game_link.rs: together they prove the extension emits only links the app
// accepts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const core = await readFile(new URL("../src/core.js", import.meta.url), "utf8");
const contract = JSON.parse(
  await readFile(new URL("../link-contract.json", import.meta.url), "utf8"),
);
const dom = new JSDOM("", { runScripts: "outside-only" });
dom.window.eval(core);
const { deepLink } = dom.window.ChessRiddleStudioExtension;

test("the contract lists accepted, unlinked and refused cases", () => {
  assert.ok(contract.accepted.length >= 7);
  assert.ok(contract.notLinked.length >= 7);
  assert.ok(contract.refused.length >= 40);
});

for (const { source, link } of contract.accepted)
  test(`links ${source} exactly as the app accepts it`, () => assert.equal(deepLink(source), link));

for (const source of contract.notLinked)
  test(`emits no link for ${source}`, () => assert.equal(deepLink(source), null));

test("never emits a link the app refuses", () => {
  const refused = new Set(contract.refused);
  for (const source of [
    ...contract.accepted.map((entry) => entry.source),
    ...contract.notLinked,
    ...contract.refused,
  ]) {
    const link = deepLink(source);
    if (link !== null) assert.ok(!refused.has(link), `${source} produced the refused ${link}`);
  }
});
