import { HistoryEvent, InventoryState, Item, ITEM_STATUSES, Location, SheetConfig, makeId, seedItems, seedLocations } from "./inventory";
import { SortDraft } from "./sorting";

const DB_NAME = "findry-inventory";
const DB_VERSION = 2;
const DEVICE_KEY = "device-id";
export const RECYCLE_BIN_LOCATION_ID = "LOC-RECYCLE-BIN";

type StoreName = "items" | "locations" | "history" | "settings" | "snapshots" | "sortDrafts";

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
      if (!db.objectStoreNames.contains("sortDrafts")) db.createObjectStore("sortDrafts", { keyPath: "id" });
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
  const initialized = await setting<boolean>("inventory-initialized");
  if (!items.length && !locations.length && !initialized) {
    const db = await openDatabase();
    const tx = db.transaction(["items", "locations"], "readwrite");
    seedItems.forEach((item) => tx.objectStore("items").put(item));
    seedLocations.forEach((location) => tx.objectStore("locations").put(location));
    await transactionDone(tx);
    db.close();
    items = seedItems;
    locations = seedLocations;
  }
  if (!initialized) await setSetting("inventory-initialized", true);
  locations = locations.map((location) => ({ ...location, deletedAt: location.deletedAt ?? "" }));
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
    ? ["name", "parentId", "notes", "deletedAt"].filter((field) => displayValue(previous[field as keyof Location]) !== displayValue(location[field as keyof Location]))
    : ["*"];
  const events = fields.map((field): HistoryEvent => ({
    id: makeId("CHANGE"), entityType: "location", entityId: location.id,
    action: previous ? (location.deletedAt && !previous.deletedAt ? "delete" : "update") : "create", field,
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

export interface LocationDeletionResult {
  recycleBin: Location;
  deletedLocation: Location;
  movedItems: Item[];
  movedChildren: Location[];
  events: HistoryEvent[];
}

export async function deleteLocationAndRecycle(
  location: Location,
  recycleBinCandidate: Location | undefined,
  items: Item[],
  childLocations: Location[],
): Promise<LocationDeletionResult> {
  const deviceId = await getDeviceId();
  const changedAt = new Date().toISOString();
  const recycleBinNeedsUpdate = !recycleBinCandidate || recycleBinCandidate.deletedAt || recycleBinCandidate.name !== "Recycle bin" || recycleBinCandidate.parentId;
  const recycleBin: Location = recycleBinCandidate
    ? {
        ...recycleBinCandidate,
        name: "Recycle bin",
        parentId: "",
        notes: recycleBinCandidate.notes || "Items moved from deleted locations",
        updatedAt: recycleBinNeedsUpdate ? changedAt : recycleBinCandidate.updatedAt,
        version: recycleBinNeedsUpdate ? recycleBinCandidate.version + 1 : recycleBinCandidate.version,
        deletedAt: "",
      }
    : {
        id: RECYCLE_BIN_LOCATION_ID,
        name: "Recycle bin",
        parentId: "",
        notes: "Items moved from deleted locations",
        createdAt: changedAt,
        updatedAt: changedAt,
        version: 1,
        deletedAt: "",
      };
  const deletedLocation: Location = { ...location, deletedAt: changedAt, updatedAt: changedAt, version: location.version + 1 };
  const movedItems = items.map((item) => ({ ...item, locationId: recycleBin.id, updatedAt: changedAt, version: item.version + 1 }));
  const movedChildren = childLocations.map((child) => ({ ...child, parentId: location.parentId, updatedAt: changedAt, version: child.version + 1 }));
  const events: HistoryEvent[] = [];
  if (!recycleBinCandidate) {
    events.push({ id: makeId("CHANGE"), entityType: "location", entityId: recycleBin.id, action: "create", field: "*", oldValue: "", newValue: recycleBin.name, changedAt, deviceId, synced: false });
  } else if (recycleBinNeedsUpdate) {
    events.push({ id: makeId("CHANGE"), entityType: "location", entityId: recycleBin.id, action: "update", field: "*", oldValue: recycleBinCandidate.name, newValue: recycleBin.name, changedAt, deviceId, synced: false });
  }
  movedItems.forEach((item) => events.push({ id: makeId("CHANGE"), entityType: "item", entityId: item.id, action: "update", field: "locationId", oldValue: location.id, newValue: recycleBin.id, changedAt, deviceId, synced: false }));
  movedChildren.forEach((child) => events.push({ id: makeId("CHANGE"), entityType: "location", entityId: child.id, action: "update", field: "parentId", oldValue: location.id, newValue: location.parentId, changedAt, deviceId, synced: false }));
  events.push({ id: makeId("CHANGE"), entityType: "location", entityId: location.id, action: "delete", field: "*", oldValue: location.name, newValue: recycleBin.name, changedAt, deviceId, synced: false });

  const db = await openDatabase();
  const tx = db.transaction(["items", "locations", "history"], "readwrite");
  tx.objectStore("locations").put(recycleBin);
  tx.objectStore("locations").put(deletedLocation);
  movedChildren.forEach((child) => tx.objectStore("locations").put(child));
  movedItems.forEach((item) => tx.objectStore("items").put(item));
  events.forEach((event) => tx.objectStore("history").put(event));
  await transactionDone(tx);
  db.close();
  await createDailySnapshot();
  return { recycleBin, deletedLocation, movedItems, movedChildren, events };
}

export async function replaceFromSync(state: InventoryState) {
  const db = await openDatabase();
  const tx = db.transaction(["items", "locations", "history", "sortDrafts"], "readwrite");
  state.items.forEach((item) => tx.objectStore("items").put(item));
  state.locations.forEach((location) => tx.objectStore("locations").put(location));
  state.history.forEach((event) => tx.objectStore("history").put({ ...event, synced: true }));
  tx.objectStore("sortDrafts").clear();
  await transactionDone(tx);
  db.close();
  await setSetting("last-sync", new Date().toISOString());
}

export async function getLatestSortDraft(): Promise<SortDraft | undefined> {
  const drafts = await all<SortDraft>("sortDrafts");
  return drafts.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export async function saveSortDraft(draft: SortDraft) {
  const db = await openDatabase();
  const tx = db.transaction("sortDrafts", "readwrite");
  tx.objectStore("sortDrafts").clear();
  tx.objectStore("sortDrafts").put(draft);
  await transactionDone(tx);
  db.close();
}

export async function clearSortDraft() {
  const db = await openDatabase();
  const tx = db.transaction("sortDrafts", "readwrite");
  tx.objectStore("sortDrafts").clear();
  await transactionDone(tx);
  db.close();
}

export interface AppliedSortResult {
  movedItems: Item[];
  createdLocations: Location[];
  events: HistoryEvent[];
  staleItemIds: string[];
}

export async function applySortRecommendations(draft: SortDraft, state: InventoryState): Promise<AppliedSortResult> {
  const deviceId = await getDeviceId();
  const changedAt = new Date().toISOString();
  const activeLocationIds = new Set(state.locations.filter((location) => !location.deletedAt).map((location) => location.id));
  const accepted = draft.recommendations.filter((recommendation) => recommendation.reviewStatus === "accepted");
  const staleItemIds: string[] = [];
  const applicable = accepted.filter((recommendation) => {
    const item = state.items.find((candidate) => candidate.id === recommendation.itemId);
    const valid = item && !item.deletedAt && item.locationId === draft.sourceLocationId && item.version === recommendation.itemVersion;
    if (!valid) staleItemIds.push(recommendation.itemId);
    return valid;
  });
  const requiredProposalIds = new Set(applicable.filter((row) => row.destinationKind === "proposed").map((row) => row.destinationId));
  const proposalIdMap = new Map<string, string>();
  const createdLocations: Location[] = draft.proposedLocations.filter((proposal) => requiredProposalIds.has(proposal.id)).map((proposal) => {
    const id = makeId("LOC");
    proposalIdMap.set(proposal.id, id);
    return {
      id,
      name: proposal.name.trim() || "New location",
      parentId: activeLocationIds.has(proposal.parentId) ? proposal.parentId : "",
      notes: proposal.reason.trim(),
      createdAt: changedAt,
      updatedAt: changedAt,
      version: 1,
      deletedAt: "",
    };
  });
  const movedItems: Item[] = [];
  const events: HistoryEvent[] = createdLocations.map((location) => ({
    id: makeId("CHANGE"), entityType: "location", entityId: location.id, action: "create", field: "*", oldValue: "", newValue: location.name, changedAt, deviceId, synced: false,
  }));
  applicable.forEach((recommendation) => {
    const item = state.items.find((candidate) => candidate.id === recommendation.itemId)!;
    const destinationId = recommendation.destinationKind === "proposed" ? proposalIdMap.get(recommendation.destinationId) : recommendation.destinationId;
    if (!destinationId || (!activeLocationIds.has(destinationId) && !createdLocations.some((location) => location.id === destinationId))) {
      staleItemIds.push(item.id);
      return;
    }
    movedItems.push({ ...item, locationId: destinationId, updatedAt: changedAt, version: item.version + 1 });
    events.push({ id: makeId("CHANGE"), entityType: "item", entityId: item.id, action: "update", field: "locationId", oldValue: item.locationId, newValue: destinationId, changedAt, deviceId, synced: false });
  });
  const db = await openDatabase();
  const tx = db.transaction(["items", "locations", "history", "snapshots", "sortDrafts"], "readwrite");
  tx.objectStore("snapshots").put({ id: `pre-sort-${changedAt}`, createdAt: changedAt, reason: "Before applying sorting recommendations", state });
  createdLocations.forEach((location) => tx.objectStore("locations").put(location));
  movedItems.forEach((item) => tx.objectStore("items").put(item));
  events.forEach((event) => tx.objectStore("history").put(event));
  tx.objectStore("sortDrafts").clear();
  await transactionDone(tx);
  db.close();
  return { movedItems, createdLocations, events, staleItemIds };
}

export async function getSheetConfig(): Promise<SheetConfig | undefined> {
  return setting<SheetConfig>("sheet-config");
}

export async function saveSheetConfig(config: SheetConfig) {
  await setSetting("sheet-config", config);
}

export async function getSyncEnabled() {
  return (await setting<boolean>("sync-enabled")) ?? false;
}

export async function saveSyncEnabled(enabled: boolean) {
  await setSetting("sync-enabled", enabled);
}

export async function getLastItemLocation() {
  return (await setting<string>("last-item-location")) ?? "";
}

export async function saveLastItemLocation(locationId: string) {
  await setSetting("last-item-location", locationId);
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
  link.download = `tool-findy-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  await setSetting("last-export", new Date().toISOString());
}

export interface BackupRestoreCandidate {
  fileName: string;
  exportedAt: string;
  sourceDeviceId: string;
  state: InventoryState;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Backup is invalid: ${label} is missing.`);
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function timestamp(value: unknown, fallback: string) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function version(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}

function uniqueIds(records: Array<{ id: string }>, label: string) {
  const ids = new Set<string>();
  records.forEach(({ id }) => {
    if (ids.has(id)) throw new Error(`Backup is invalid: duplicate ${label} ID ${id}.`);
    ids.add(id);
  });
}

export async function readBackupFile(file: File): Promise<BackupRestoreCandidate> {
  if (!file.name.toLowerCase().endsWith(".json")) throw new Error("Choose a Tool Findy JSON backup file.");
  if (file.size > 50 * 1024 * 1024) throw new Error("That backup is larger than 50 MB and cannot be restored safely in the browser.");
  let payload: unknown;
  try { payload = JSON.parse(await file.text()); }
  catch { throw new Error("That file is not valid JSON. Choose a backup created by Tool Findy."); }
  if (!record(payload) || payload.schemaVersion !== 1) throw new Error("This is not a supported Tool Findy backup (schema version 1 required).");
  const exportedAt = requiredString(payload.exportedAt, "export date");
  if (Number.isNaN(Date.parse(exportedAt))) throw new Error("Backup is invalid: export date cannot be read.");
  if (!Array.isArray(payload.items) || !Array.isArray(payload.locations) || !Array.isArray(payload.history)) throw new Error("Backup is invalid: items, locations, or history are missing.");

  const items = payload.items.map((value, index): Item => {
    if (!record(value)) throw new Error(`Backup is invalid: item ${index + 1} cannot be read.`);
    const itemStatus = typeof value.status === "string" && ITEM_STATUSES.includes(value.status as Item["status"]) ? value.status as Item["status"] : "Available";
    const quantity = Number(value.quantity);
    return {
      id: requiredString(value.id, `item ${index + 1} ID`),
      name: requiredString(value.name, `item ${index + 1} name`),
      category: optionalString(value.category) || "Uncategorized",
      locationId: optionalString(value.locationId),
      quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 0,
      status: itemStatus,
      tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
      notes: optionalString(value.notes),
      createdAt: timestamp(value.createdAt, exportedAt),
      updatedAt: timestamp(value.updatedAt, exportedAt),
      version: version(value.version),
      deletedAt: optionalString(value.deletedAt),
    };
  });
  const locations = payload.locations.map((value, index): Location => {
    if (!record(value)) throw new Error(`Backup is invalid: location ${index + 1} cannot be read.`);
    return {
      id: requiredString(value.id, `location ${index + 1} ID`),
      name: requiredString(value.name, `location ${index + 1} name`),
      parentId: optionalString(value.parentId),
      notes: optionalString(value.notes),
      createdAt: timestamp(value.createdAt, exportedAt),
      updatedAt: timestamp(value.updatedAt, exportedAt),
      version: version(value.version),
      deletedAt: optionalString(value.deletedAt),
    };
  });
  const history = payload.history.map((value, index): HistoryEvent => {
    if (!record(value)) throw new Error(`Backup is invalid: history entry ${index + 1} cannot be read.`);
    const entityType = value.entityType === "location" || value.entityType === "system" ? value.entityType : "item";
    const action = value.action === "create" || value.action === "delete" || value.action === "sync" || value.action === "import" ? value.action : "update";
    return {
      id: requiredString(value.id, `history entry ${index + 1} ID`),
      entityType,
      entityId: requiredString(value.entityId, `history entry ${index + 1} entity ID`),
      action,
      field: optionalString(value.field) || "*",
      oldValue: optionalString(value.oldValue),
      newValue: optionalString(value.newValue),
      changedAt: timestamp(value.changedAt, exportedAt),
      deviceId: optionalString(value.deviceId) || "backup",
      synced: value.synced === true,
    };
  });
  uniqueIds(items, "item");
  uniqueIds(locations, "location");
  uniqueIds(history, "history");
  return { fileName: file.name, exportedAt, sourceDeviceId: optionalString(payload.deviceId) || "unknown device", state: { items, locations, history: history.sort((a, b) => b.changedAt.localeCompare(a.changedAt)) } };
}

export async function restoreBackup(candidate: BackupRestoreCandidate): Promise<InventoryState> {
  const currentState: InventoryState = {
    items: await all<Item>("items"),
    locations: await all<Location>("locations"),
    history: await all<HistoryEvent>("history"),
  };
  const changedAt = new Date().toISOString();
  const deviceId = await getDeviceId();
  const restoreEvent: HistoryEvent = {
    id: makeId("CHANGE"), entityType: "system", entityId: "local-backup", action: "import", field: "*",
    oldValue: `${currentState.items.length} items, ${currentState.locations.length} locations`,
    newValue: `${candidate.fileName} exported ${candidate.exportedAt}`,
    changedAt, deviceId, synced: false,
  };
  const restoredState: InventoryState = { ...candidate.state, history: [restoreEvent, ...candidate.state.history] };
  const db = await openDatabase();
  const tx = db.transaction(["items", "locations", "history", "settings", "snapshots", "sortDrafts"], "readwrite");
  tx.objectStore("snapshots").put({ id: `pre-restore-${changedAt}`, createdAt: changedAt, reason: `Before restoring ${candidate.fileName}`, state: currentState });
  tx.objectStore("items").clear();
  tx.objectStore("locations").clear();
  tx.objectStore("history").clear();
  tx.objectStore("sortDrafts").clear();
  restoredState.items.forEach((item) => tx.objectStore("items").put(item));
  restoredState.locations.forEach((location) => tx.objectStore("locations").put(location));
  restoredState.history.forEach((event) => tx.objectStore("history").put(event));
  tx.objectStore("settings").put({ key: "inventory-initialized", value: true });
  tx.objectStore("settings").put({ key: "last-restore", value: changedAt });
  tx.objectStore("settings").put({ key: "last-snapshot-date", value: "" });
  tx.objectStore("settings").put({ key: "last-item-location", value: "" });
  await transactionDone(tx);
  db.close();
  return restoredState;
}
