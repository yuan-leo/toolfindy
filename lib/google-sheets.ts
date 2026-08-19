import { HistoryEvent, InventoryState, Item, Location, SheetConfig } from "./inventory";

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(options: { client_id: string; scope: string; callback: (response: { access_token?: string; error?: string }) => void }): { requestAccessToken(options?: { prompt?: string }): void };
          revoke(token: string): void;
        };
      };
    };
  }
}

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const REQUIRED_TABS = ["Items", "Locations", "History", "Settings"];

let accessToken = "";

export function setGoogleAccessToken(token: string) {
  accessToken = token;
}

async function loadIdentityLibrary() {
  if (window.google?.accounts.oauth2) return;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Could not load Google sign-in")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Google sign-in"));
    document.head.appendChild(script);
  });
}

export async function authorizeGoogle(clientId: string) {
  await loadIdentityLibrary();
  accessToken = await new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      callback: (response) => response.access_token ? resolve(response.access_token) : reject(new Error(response.error || "Google authorization was cancelled")),
    });
    client.requestAccessToken({ prompt: "consent" });
  });
  return accessToken;
}

async function googleFetch(path: string, init?: RequestInit) {
  if (!accessToken) throw new Error("Connect your Google account before syncing");
  const response = await fetch(path.startsWith("http") ? path : `${API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail?.error?.message || `Google Sheets request failed (${response.status})`);
  }
  return response.json();
}

async function ensureWorkbook(config: SheetConfig) {
  const metadata = await googleFetch(`${config.spreadsheetId}?fields=sheets.properties`);
  const existing = new Set<string>((metadata.sheets ?? []).map((sheet: { properties: { title: string } }) => sheet.properties.title));
  const missing = REQUIRED_TABS.filter((name) => !existing.has(name));
  if (missing.length) {
    await googleFetch(`${config.spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }),
    });
  }
}

function rowsToObjects<T>(rows: string[][] | undefined): T[] {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]))) as T[];
}

function parseItem(row: Record<string, string>): Item {
  return { id: row.item_id, name: row.name, category: row.category, locationId: row.location_id, quantity: Number(row.quantity || 0), status: (row.status || "Available") as Item["status"], tags: row.tags ? row.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [], notes: row.notes || "", createdAt: row.created_at || new Date().toISOString(), updatedAt: row.updated_at || new Date().toISOString(), version: Number(row.version || 1), deletedAt: row.deleted_at || "" };
}

function parseLocation(row: Record<string, string>): Location {
  return { id: row.location_id, name: row.name, parentId: row.parent_id || "", notes: row.notes || "", createdAt: row.created_at || new Date().toISOString(), updatedAt: row.updated_at || new Date().toISOString(), version: Number(row.version || 1) };
}

function parseHistory(row: Record<string, string>): HistoryEvent {
  return { id: row.change_id, entityType: (row.entity_type || "item") as HistoryEvent["entityType"], entityId: row.entity_id, action: (row.action || "update") as HistoryEvent["action"], field: row.field || "*", oldValue: row.old_value || "", newValue: row.new_value || "", changedAt: row.changed_at || new Date().toISOString(), deviceId: row.device_id || "sheet", synced: true };
}

function mergeById<T extends { id: string; updatedAt?: string; version?: number }>(local: T[], remote: T[]) {
  const merged = new Map<string, T>();
  [...remote, ...local].forEach((record) => {
    const previous = merged.get(record.id);
    if (!previous) return void merged.set(record.id, record);
    const currentRank = `${String(record.version ?? 0).padStart(10, "0")}-${record.updatedAt ?? ""}`;
    const previousRank = `${String(previous.version ?? 0).padStart(10, "0")}-${previous.updatedAt ?? ""}`;
    if (currentRank >= previousRank) merged.set(record.id, record);
  });
  return [...merged.values()];
}

export async function synchronizeSheets(config: SheetConfig, local: InventoryState): Promise<InventoryState> {
  await ensureWorkbook(config);
  const ranges = REQUIRED_TABS.map((name) => encodeURIComponent(`${name}!A:Z`)).join("&ranges=");
  const remote = await googleFetch(`${config.spreadsheetId}/values:batchGet?ranges=${ranges}&majorDimension=ROWS`);
  const valueRanges = remote.valueRanges ?? [];
  const remoteItems = rowsToObjects<Record<string, string>>(valueRanges[0]?.values).map(parseItem).filter((item) => item.id);
  const remoteLocations = rowsToObjects<Record<string, string>>(valueRanges[1]?.values).map(parseLocation).filter((location) => location.id);
  const remoteHistory = rowsToObjects<Record<string, string>>(valueRanges[2]?.values).map(parseHistory).filter((event) => event.id);
  const items = mergeById(local.items, remoteItems);
  const locations = mergeById(local.locations, remoteLocations);
  const historyMap = new Map([...remoteHistory, ...local.history].map((event) => [event.id, { ...event, synced: true }]));
  const history = [...historyMap.values()].sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  const itemRows = [["item_id", "name", "category", "location_id", "quantity", "status", "tags", "notes", "created_at", "updated_at", "version", "deleted_at"], ...items.map((item) => [item.id, item.name, item.category, item.locationId, item.quantity, item.status, item.tags.join(", "), item.notes, item.createdAt, item.updatedAt, item.version, item.deletedAt])];
  const locationRows = [["location_id", "name", "parent_id", "notes", "created_at", "updated_at", "version"], ...locations.map((location) => [location.id, location.name, location.parentId, location.notes, location.createdAt, location.updatedAt, location.version])];
  const historyRows = [["change_id", "entity_type", "entity_id", "action", "field", "old_value", "new_value", "changed_at", "device_id"], ...history.map((event) => [event.id, event.entityType, event.entityId, event.action, event.field, event.oldValue, event.newValue, event.changedAt, event.deviceId])];
  const settingsRows = [["key", "value"], ["schema_version", "1"], ["last_synced_at", new Date().toISOString()], ["app", "Findry"]];
  await googleFetch(`${config.spreadsheetId}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: [
    { range: `Items!A1:L${itemRows.length}`, values: itemRows },
    { range: `Locations!A1:G${locationRows.length}`, values: locationRows },
    { range: `History!A1:I${historyRows.length}`, values: historyRows },
    { range: `Settings!A1:B${settingsRows.length}`, values: settingsRows },
  ] }) });
  return { items, locations, history: history.sort((a, b) => b.changedAt.localeCompare(a.changedAt)) };
}
