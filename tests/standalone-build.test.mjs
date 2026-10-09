import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const outputDirectory = new URL("../standalone-dist/", import.meta.url);
const outputFile = new URL("Tool-Findy-Standalone.html", outputDirectory);

test("emits exactly one double-clickable HTML file", async () => {
  assert.deepEqual(await readdir(outputDirectory), ["Tool-Findy-Standalone.html"]);
  const html = await readFile(outputFile, "utf8");
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<title>Tool Findy - Standalone Local Edition<\/title>/);
  assert.match(html, /<style>[\s\S]+<\/style>/);
  assert.match(html, /<script>[\s\S]+<\/script>/);
  assert.doesNotMatch(html, /<script type="module"|<link rel="stylesheet"/i);
});

test("keeps local inventory workflows and isolated persistence", async () => {
  const html = await readFile(outputFile, "utf8");
  for (const capability of [
    "Standalone local edition",
    "tool-findy-standalone-inventory",
    "Batch add items",
    "Move selected",
    "Sorting inbox",
    "Copy chat prompt",
    "Paste from clipboard",
    "Change history",
    "Restore backup",
    "Recycle bin",
    "Location hierarchy",
  ]) assert.match(html, new RegExp(capability, "i"));
  assert.match(html, /aria-sort/);
  assert.match(html, /aria-autocomplete/);
  assert.match(html, /snapshot-/);
});

test("contains no cloud sync UI, implementation, or service-worker startup", async () => {
  const html = await readFile(outputFile, "utf8");
  assert.doesNotMatch(html, /Google|OAuth|Connect sheet|Allow web sync|sync diagnostic|sheets\.googleapis\.com|accounts\.google\.com/i);
  assert.doesNotMatch(html, /serviceWorker\.register|\/sw\.js/i);
});
