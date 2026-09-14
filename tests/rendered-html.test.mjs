import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the Tool Findy application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Tool Findy - Tool Inventory<\/title>/i);
  assert.match(html, /Tool Findy/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps local-first, keyboard, Sheets, and PWA capabilities in the build", async () => {
  const [app, localStore, sheets, manifest, serviceWorker, chatSorting, portableServer] = await Promise.all([
    readFile(new URL("../app/InventoryApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/google-sheets.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/chat-sorting.ts", import.meta.url), "utf8"),
    readFile(new URL("../portable-windows/server.cjs", import.meta.url), "utf8"),
  ]);
  assert.match(app, /ArrowDown|requestSubmit|aria-live/);
  assert.match(app, /Batch add items|submitBatchItems|one per line/);
  assert.match(app, /setBatchLocationId\(rememberedLocation\)/);
  assert.match(app, /checkedItemIds|Select all visible items|Move selected/);
  assert.match(app, /toggleInventorySort|aria-sort|ascending|descending/);
  assert.match(app, /moveCheckedItems|saveItem\(item, previous\)/);
  assert.match(app, /More fields|aria-expanded|item-extra-fields/);
  assert.match(app, /Location hierarchy|role="tree"|moveLocation/);
  assert.match(app, /draggable|onDragStart|Top level/);
  assert.match(app, /Add location|locationReturnDialog/);
  assert.match(app, /openNewLocation\("batch"\)|setBatchLocationId\(location\.id\)/);
  assert.match(app, /locationOptions.*flattenLocationTree|children.*localeCompare|visit\(location\.id, depth \+ 1\)/s);
  assert.match(app, /LocationCombobox|filterAndRankLocationOptions|aria-autocomplete="list"/);
  assert.match(app, /bottommostMatch|startsWithSearch|matchLevel/);
  assert.match(app, /Delete location|delete-location|Confirm deletion/);
  assert.match(app, /Recycle bin|confirmDeleteLocation|activeLocations/);
  assert.match(app, /Allow web sync|role="switch"|Sync disabled/);
  assert.match(app, /Google sync diagnostic|Authorized JavaScript origin|syncError/);
  assert.match(app, /selectBackupFile|confirmRestore|Restore backup/);
  assert.match(app, /Sorting inbox|Copy chat prompt|Load suggestions|Apply.*accepted/);
  assert.match(app, /Paste from clipboard|Tool Findy makes no AI API requests/);
  assert.match(app, /to be sorted|updateSortRecommendation|reviewStatus/);
  assert.match(localStore, /indexedDB\.open|snapshots|downloadBackup/);
  assert.match(localStore, /readBackupFile|restoreBackup|pre-restore-/);
  assert.match(localStore, /inventory-initialized/);
  assert.match(localStore, /getSyncEnabled|sync-enabled/);
  assert.match(localStore, /getLastItemLocation|last-item-location/);
  assert.match(localStore, /deleteLocationAndRecycle|RECYCLE_BIN_LOCATION_ID/);
  assert.match(localStore, /applySortRecommendations|pre-sort-|sortDrafts/);
  assert.match(localStore, /action: "delete"|movedItems|movedChildren/);
  assert.match(sheets, /sheets\.googleapis\.com|authorizeGoogle|batchUpdate/);
  assert.match(sheets, /error_callback|popup_failed_to_open|sheetsErrorMessage/);
  assert.match(sheets, /deleted_at|Locations!A1:H/);
  assert.match(manifest, /"display": "standalone"/);
  assert.match(serviceWorker, /caches\.open/);
  assert.match(chatSorting, /createSortingPrompt|parseSortRecommendations|Return ONLY valid JSON/);
  assert.match(chatSorting, /proposedLocations|destinationKind|expectedItemIds/);
  assert.doesNotMatch(portableServer, /OPENAI_API_KEY|\/api\/sort-recommendations/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

