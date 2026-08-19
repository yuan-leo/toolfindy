export type ItemStatus = "Available" | "Low stock" | "Checked out" | "Needs repair" | "Archived";

export interface Item {
  id: string;
  name: string;
  category: string;
  locationId: string;
  quantity: number;
  status: ItemStatus;
  tags: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string;
}

export interface Location {
  id: string;
  name: string;
  parentId: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface HistoryEvent {
  id: string;
  entityType: "item" | "location" | "system";
  entityId: string;
  action: "create" | "update" | "delete" | "sync" | "import";
  field: string;
  oldValue: string;
  newValue: string;
  changedAt: string;
  deviceId: string;
  synced: boolean;
}

export interface InventoryState {
  items: Item[];
  locations: Location[];
  history: HistoryEvent[];
}

export interface SheetConfig {
  clientId: string;
  spreadsheetId: string;
  sheetUrl: string;
}

export const ITEM_STATUSES: ItemStatus[] = ["Available", "Low stock", "Checked out", "Needs repair", "Archived"];

export function makeId(prefix: string) {
  const token = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${token}`;
}

export function locationPath(locationId: string, locations: Location[]) {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = locations.find((location) => location.id === locationId);
  while (current && !seen.has(current.id)) {
    parts.unshift(current.name);
    seen.add(current.id);
    current = locations.find((location) => location.id === current?.parentId);
  }
  return parts.join(" / ") || "Unassigned";
}

const now = new Date().toISOString();

export const seedLocations: Location[] = [
  { id: "LOC-GARAGE", name: "Garage", parentId: "", notes: "", createdAt: now, updatedAt: now, version: 1 },
  { id: "LOC-CABINET-A", name: "Cabinet A", parentId: "LOC-GARAGE", notes: "Left wall", createdAt: now, updatedAt: now, version: 1 },
  { id: "LOC-DRAWER-3", name: "Drawer 3", parentId: "LOC-GARAGE", notes: "", createdAt: now, updatedAt: now, version: 1 },
  { id: "LOC-BIN-B14", name: "Bin B14", parentId: "LOC-GARAGE", notes: "Small hardware", createdAt: now, updatedAt: now, version: 1 },
  { id: "LOC-WORKSHOP", name: "Workshop", parentId: "", notes: "", createdAt: now, updatedAt: now, version: 1 },
  { id: "LOC-RED-TOTE", name: "Red tote", parentId: "LOC-WORKSHOP", notes: "Electrical kit", createdAt: now, updatedAt: now, version: 1 },
  { id: "LOC-SHELF-2", name: "Shelf 2", parentId: "LOC-WORKSHOP", notes: "", createdAt: now, updatedAt: now, version: 1 },
];

export const seedItems: Item[] = [
  { id: "TL-018", name: "Cordless drill", category: "Power tools", locationId: "LOC-CABINET-A", quantity: 1, status: "Available", tags: ["drill", "20V"], notes: "Includes charger", createdAt: now, updatedAt: now, version: 1, deletedAt: "" },
  { id: "TL-031", name: "Digital multimeter", category: "Electrical", locationId: "LOC-RED-TOTE", quantity: 1, status: "Available", tags: ["meter", "diagnostic"], notes: "Stored with probes", createdAt: now, updatedAt: now, version: 1, deletedAt: "" },
  { id: "HW-104", name: "M5 × 20 mm bolts", category: "Hardware", locationId: "LOC-BIN-B14", quantity: 36, status: "Low stock", tags: ["metric", "bolt"], notes: "Zinc plated", createdAt: now, updatedAt: now, version: 1, deletedAt: "" },
  { id: "TL-044", name: "Torque wrench", category: "Bike tools", locationId: "LOC-DRAWER-3", quantity: 1, status: "Checked out", tags: ["bike", "calibrated"], notes: "Loaned to Sam", createdAt: now, updatedAt: now, version: 1, deletedAt: "" },
  { id: "PT-009", name: "3/8 in. socket set", category: "Hand tools", locationId: "LOC-SHELF-2", quantity: 1, status: "Available", tags: ["socket", "ratchet"], notes: "Metric and SAE", createdAt: now, updatedAt: now, version: 1, deletedAt: "" },
];
