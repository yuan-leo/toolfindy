import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the Findry application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Findry — Tool Inventory<\/title>/i);
  assert.match(html, /Findry/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps local-first, keyboard, Sheets, and PWA capabilities in the build", async () => {
  const [app, localStore, sheets, manifest, serviceWorker] = await Promise.all([
    readFile(new URL("../app/InventoryApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/google-sheets.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /ArrowDown|requestSubmit|aria-live/);
  assert.match(app, /Allow web sync|role="switch"|Sync disabled/);
  assert.match(localStore, /indexedDB\.open|snapshots|downloadBackup/);
  assert.match(localStore, /getSyncEnabled|sync-enabled/);
  assert.match(sheets, /sheets\.googleapis\.com|authorizeGoogle|batchUpdate/);
  assert.match(manifest, /"display": "standalone"/);
  assert.match(serviceWorker, /caches\.open/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
