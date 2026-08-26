import { HistoryEvent, InventoryState, Item, Location, SheetConfig } from "./inventory";

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(options: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string; error_description?: string; error_uri?: string }) => void;
            error_callback?: (error: { type?: "popup_failed_to_open" | "popup_closed" | "unknown"; message?: string }) => void;
          }): { requestAccessToken(options?: { prompt?: string }): void };
          revoke(token: string): void;
        };
      };
    };
  }
}

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const REQUIRED_TABS = ["Items", "Locations", "History", "Settings"];

let accessToken = "";
let identityLibraryPromise: Promise<void> | undefined;

export function setGoogleAccessToken(token: string) {
  accessToken = token;
}

async function loadIdentityLibrary() {
  if (window.google?.accounts.oauth2) return;
  if (identityLibraryPromise) return identityLibraryPromise;
  identityLibraryPromise = new Promise<void>((resolve, reject) => {
    const fail = (message: string) => {
      identityLibraryPromise = undefined;
      reject(new Error(message));
    };
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (existing) existing.remove();
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.referrerPolicy = "no-referrer-when-downgrade";
    script.onload = () => window.google?.accounts.oauth2 ? resolve() : fail("Google sign-in loaded incorrectly. Reload Tool Findy and try again.");
    script.onerror = () => { script.remove(); fail("Could not load Google sign-in. Check the internet connection or turn off sync."); };
    document.head.appendChild(script);
  });
  return identityLibraryPromise;
}

export async function authorizeGoogle(clientId: string) {
  if (!/^[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(clientId.trim())) throw new Error("The OAuth client ID is not a valid Google Web client ID.");
  await loadIdentityLibrary();
  accessToken = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => { if (!settled) { settled = true; operation(); } };
    const rejectOnce = (message: string) => finish(() => reject(new Error(message)));
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope: "https://www.googleapis.com/auth/spreadsheets",
      callback: (response) => response.access_token
        ? finish(() => resolve(response.access_token!))
        : rejectOnce(response.error_description || response.error || "Google authorization was cancelled."),
      error_callback: (error) => {
        if (error.type === "popup_failed_to_open") rejectOnce("Google sign-in could not open. Allow popups for Tool Findy, then try again.");
        else if (error.type === "popup_closed") rejectOnce("Google sign-in was closed before authorization finished.");
        else rejectOnce(`Google rejected this local browser origin (${window.location.origin}). Add this exact address to the OAuth client's Authorized JavaScript origins.`);
      },
    });
    try { client.requestAccessToken({ prompt: "consent" }); }
    catch (error) { rejectOnce(error instanceof Error ? error.message : "Google sign-in could not start."); }
  });
  return accessToken;
}

function sheetsErrorMessage(status: number, detail: { error?: { message?: string; status?: string; errors?: Array<{ reason?: string }> } }) {
  const message = detail.error?.message || `Google Sheets request failed (${status}).`;
  const reason = detail.error?.errors?.[0]?.reason || detail.error?.status || "";
  if (status === 401) return "The Google authorization expired. Choose Sync now and sign in again.";
  if (status === 404) return "Google could not find that spreadsheet. Check the Sheet link and make sure the signed-in account can open it.";
  if (status === 403 && /not been used|disabled|accessnotconfigured|service_disabled/i.test(`${message} ${reason}`)) return "The Google Sheets API is disabled for this OAuth project. Enable Google Sheets API in Google Cloud, wait a minute, then try again.";
  if (status === 403) return `Google denied edit access to this spreadsheet. Sign in with an account that can edit the Sheet. Google said: ${message}`;
  if (status === 400) return `Google rejected the spreadsheet request. Check that the Sheet link points to a normal Google Sheet. Google said: ${message}`;
  return message;
}

async function googleFetch(path: string, init?: RequestInit) {
  if (!accessToken) throw new Error("Connect your Google account before syncing");
  const response = await fetch(path.startsWith("http") ? path : `${API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: { message?: string; status?: string; errors?: Array<{ reason?: string }> } };
    throw new Error(sheetsErrorMessage(response.status, detail));
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
  return { id: row.location_id, name: row.name, parentId: row.parent_id || "", notes: row.notes || "", createdAt: row.created_at || new Date().toISOString(), updatedAt: row.updated_at || new Date().toISOString(), version: Number(row.version || 1), deletedAt: row.deleted_at || "" };
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
  const locationRows = [["location_id", "name", "parent_id", "notes", "created_at", "updated_at", "version", "deleted_at"], ...locations.map((location) => [location.id, location.name, location.parentId, location.notes, location.createdAt, location.updatedAt, location.version, location.deletedAt])];
  const historyRows = [["change_id", "entity_type", "entity_id", "action", "field", "old_value", "new_value", "changed_at", "device_id"], ...history.map((event) => [event.id, event.entityType, event.entityId, event.action, event.field, event.oldValue, event.newValue, event.changedAt, event.deviceId])];
  const settingsRows = [["key", "value"], ["schema_version", "1"], ["last_synced_at", new Date().toISOString()], ["app", "Tool Findy"]];
  await googleFetch(`${config.spreadsheetId}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: [
    { range: `Items!A1:L${itemRows.length}`, values: itemRows },
    { range: `Locations!A1:H${locationRows.length}`, values: locationRows },
    { range: `History!A1:I${historyRows.length}`, values: historyRows },
    { range: `Settings!A1:B${settingsRows.length}`, values: settingsRows },
  ] }) });
  return { items, locations, history: history.sort((a, b) => b.changedAt.localeCompare(a.changedAt)) };
}
