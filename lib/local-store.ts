import { HistoryEvent, InventoryState, Item, Location, SheetConfig, makeId, seedItems, seedLocations } from "./inventory";

const DB_NAME = "findry-inventory";
const DB_VERSION = 1;
const DEVICE_KEY = "device-id";

type StoreName = "items" | "locations" | "history" | "settings" | "snapshots";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local transaction was aborted"));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
      if (!db.objectStoreNames.contains("locations")) db.createObjectStore("locations", { keyPath: "id" });
      if (!db.objectStoreNames.contains("history")) db.createObjectStore("history", { keyPath: "id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function all<T>(storeName: StoreName): Promise<T[]> {
  const db = await openDatabase();
  const result = await requestResult(db.transaction(storeName).objectStore(storeName).getAll());
  db.close();
  return result as T[];
}

async function setting<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  const result = await requestResult(db.transaction("settings").objectStore("settings").get(key));
  db.close();
  return result?.value as T | undefined;
}

export async function setSetting<T>(key: string, value: T) {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readwrite");
  tx.objectStore("settings").put({ key, value });
  await transactionDone(tx);
  db.close();
}

export async function getDeviceId() {
  let id = await setting<string>(DEVICE_KEY);
  if (!id) {
    id = makeId("DEVICE");
    await setSetting(DEVICE_KEY, id);
  }
  return id;
}

export async function loadInventory(): Promise<InventoryState> {
  let items = await all<Item>("items");
  let locations = await all<Location>("locations");
  if (!items.length && !locations.length) {
    const db = await openDatabase();
    const tx = db.transaction(["items", "locations"], "readwrite");
    seedItems.forEach((item) => tx.objectStore("items").put(item));
    seedLocations.forEach((location) => tx.objectStore("locations").put(location));
    await transactionDone(tx);
    db.close();
    items = seedItems;
    locations = seedLocations;
  }
  const history = await all<HistoryEvent>("history");
  return { items, locations, history: history.sort((a, b) => b.changedAt.localeCompare(a.changedAt)) };
}

function displayValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null) return "";
  return String(value);
}

export async function saveItem(item: Item, previous?: Item): Promise<HistoryEvent[]> {
  const deviceId = await getDeviceId();
  const changedAt = item.updatedAt;
  const ignored = new Set(["updatedAt", "version", "createdAt"]);
  const fields = previous
    ? Object.keys(item).filter((key) => !ignored.has(key) && displayValue(previous[key as keyof Item]) !== displayValue(item[key as keyof Item]))
    : ["*"];
  const events = fields.map((field): HistoryEvent => ({
    id: makeId("CHANGE"), entityType: "item", entityId: item.id,
    action: previous ? (item.deletedAt && !previous.deletedAt ? "delete" : "update") : "create",
    field,
    oldValue: previous && field !== "*" ? displayValue(previous[field as keyof Item]) : "",
    newValue: field === "*" ? item.name : displayValue(item[field as keyof Item]),
    changedAt, deviceId, synced: false,
  }));
  const db = await openDatabase();
  const tx = db.transaction(["items", "history"], "readwrite");
  tx.objectStore("items").put(item);
  events.forEach((event) => tx.objectStore("history").put(event));
  await transactionDone(tx);
  db.close();
  await createDailySnapshot();
  return events;
}

export async function saveLocation(location: Location, previous?: Location): Promise<HistoryEvent[]> {
  const deviceId = await getDeviceId();
  const fields = previous
    ? ["name", "parentId", "notes"].filter((field) => displayValue(previous[field as keyof Location]) !== displayValue(location[field as keyof Location]))
    : ["*"];
  const events = fields.map((field): HistoryEvent => ({
    id: makeId("CHANGE"), entityType: "location", entityId: location.id, action: previous ? "update" : "create", field,
    oldValue: previous && field !== "*" ? displayValue(previous[field as keyof Location]) : "",
    newValue: field === "*" ? location.name : displayValue(location[field as keyof Location]),
    changedAt: location.updatedAt, deviceId, synced: false,
  }));
  const db = await openDatabase();
  const tx = db.transaction(["locations", "history"], "readwrite");
  tx.objectStore("locations").put(location);
  events.forEach((event) => tx.objectStore("history").put(event));
  await transactionDone(tx);
  db.close();
  await createDailySnapshot();
  return events;
}

export async function replaceFromSync(state: InventoryState) {
  const db = await openDatabase();
  const tx = db.transaction(["items", "locations", "history"], "readwrite");
  state.items.forEach((item) => tx.objectStore("items").put(item));
  state.locations.forEach((location) => tx.objectStore("locations").put(location));
  state.history.forEach((event) => tx.objectStore("history").put({ ...event, synced: true }));
  await transactionDone(tx);
  db.close();
  await setSetting("last-sync", new Date().toISOString());
}

export async function getSheetConfig(): Promise<SheetConfig | undefined> {
  return setting<SheetConfig>("sheet-config");
}

export async function saveSheetConfig(config: SheetConfig) {
  await setSetting("sheet-config", config);
}

export async function createDailySnapshot(force = false) {
  const date = new Date().toISOString().slice(0, 10);
  const lastDate = await setting<string>("last-snapshot-date");
  if (!force && lastDate === date) return;
  const state = { items: await all<Item>("items"), locations: await all<Location>("locations"), history: await all<HistoryEvent>("history") };
  const db = await openDatabase();
  const tx = db.transaction("snapshots", "readwrite");
  tx.objectStore("snapshots").put({ id: `snapshot-${date}`, createdAt: new Date().toISOString(), state });
  await transactionDone(tx);
  db.close();
  await setSetting("last-snapshot-date", date);
}

export async function downloadBackup() {
  const state = await loadInventory();
  const deviceId = await getDeviceId();
  const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), deviceId, ...state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `findry-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  await setSetting("last-export", new Date().toISOString());
}
