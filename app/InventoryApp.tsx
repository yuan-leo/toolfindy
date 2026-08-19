"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { HistoryEvent, InventoryState, Item, ItemStatus, ITEM_STATUSES, Location, SheetConfig, locationPath, makeId } from "@/lib/inventory";
import { createDailySnapshot, downloadBackup, getSheetConfig, getSyncEnabled, loadInventory, replaceFromSync, saveItem, saveLocation, saveSheetConfig, saveSyncEnabled } from "@/lib/local-store";
import { authorizeGoogle, synchronizeSheets } from "@/lib/google-sheets";

type View = "inventory" | "locations" | "history";
type DialogName = "item" | "location" | "connect" | "help" | null;
const emptyState: InventoryState = { items: [], locations: [], history: [] };
const blankItem = (): Partial<Item> => ({ name: "", category: "", locationId: "", quantity: 1, status: "Available", tags: [], notes: "" });
const blankLocation = (): Partial<Location> => ({ name: "", parentId: "", notes: "" });

export default function InventoryApp() {
  const [data, setData] = useState<InventoryState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("inventory");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All categories");
  const [locationFilter, setLocationFilter] = useState("All locations");
  const [selectedId, setSelectedId] = useState("");
  const [dialog, setDialog] = useState<DialogName>(null);
  const [itemDraft, setItemDraft] = useState<Partial<Item>>(blankItem());
  const [locationDraft, setLocationDraft] = useState<Partial<Location>>(blankLocation());
  const [sheetConfig, setSheetConfigState] = useState<SheetConfig>();
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncState, setSyncState] = useState<"local" | "connecting" | "syncing" | "synced" | "error">("local");
  const [toast, setToast] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    Promise.all([loadInventory(), getSheetConfig(), getSyncEnabled()]).then(([inventory, config, storedSyncEnabled]) => {
      setData(inventory);
      setSheetConfigState(config);
      setSyncEnabled(storedSyncEnabled);
      setSelectedId(inventory.items.find((item) => !item.deletedAt)?.id ?? "");
      setLoading(false);
      createDailySnapshot().catch(() => undefined);
    }).catch((error) => {
      setToast(`Local storage could not start: ${error.message}`);
      setLoading(false);
    });
    navigator.storage?.persist?.().catch(() => undefined);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeItems = useMemo(() => data.items.filter((item) => !item.deletedAt), [data.items]);
  const categories = useMemo(() => [...new Set(activeItems.map((item) => item.category).filter(Boolean))].sort(), [activeItems]);
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return activeItems.filter((item) => {
      const matchesQuery = !needle || [item.id, item.name, item.category, locationPath(item.locationId, data.locations), item.tags.join(" "), item.notes].join(" ").toLowerCase().includes(needle);
      return matchesQuery && (category === "All categories" || item.category === category) && (locationFilter === "All locations" || item.locationId === locationFilter);
    });
  }, [activeItems, category, data.locations, locationFilter, query]);
  const selectedIndex = Math.max(0, visibleItems.findIndex((item) => item.id === selectedId));

  function openNewItem() { setItemDraft(blankItem()); setDialog("item"); }
  function openEditItem(item = data.items.find((candidate) => candidate.id === selectedId)) { if (item) { setItemDraft({ ...item }); setDialog("item"); } }
  function openNewLocation() { setLocationDraft(blankLocation()); setDialog("location"); }
  function openEditLocation(location: Location) { setLocationDraft({ ...location }); setDialog("location"); }
  function moveSelection(delta: number) {
    if (!visibleItems.length) return;
    const next = Math.min(visibleItems.length - 1, Math.max(0, selectedIndex + delta));
    setSelectedId(visibleItems[next].id);
    requestAnimationFrame(() => document.getElementById(`row-${visibleItems[next].id}`)?.focus());
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
      if (event.key === "Escape" && dialog) { event.preventDefault(); setDialog(null); return; }
      if (event.key === "Tab" && dialog) {
        const focusable = [...document.querySelectorAll<HTMLElement>(".dialog button:not([disabled]), .dialog input:not([disabled]), .dialog select:not([disabled]), .dialog textarea:not([disabled]), .dialog a[href]")];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && dialogFormRef.current) { event.preventDefault(); dialogFormRef.current.requestSubmit(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); return; }
      if (typing || dialog) return;
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); }
      else if (event.key === "?") { event.preventDefault(); setDialog("help"); }
      else if (event.key.toLowerCase() === "n") { event.preventDefault(); view === "locations" ? openNewLocation() : openNewItem(); }
      else if (event.key.toLowerCase() === "e" && view === "inventory") { event.preventDefault(); openEditItem(); }
      else if ((event.key === "ArrowDown" || event.key.toLowerCase() === "j") && view === "inventory") { event.preventDefault(); moveSelection(1); }
      else if ((event.key === "ArrowUp" || event.key.toLowerCase() === "k") && view === "inventory") { event.preventDefault(); moveSelection(-1); }
      else if (event.key === "Enter" && view === "inventory") { event.preventDefault(); openEditItem(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  async function submitItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const previous = itemDraft.id ? data.items.find((item) => item.id === itemDraft.id) : undefined;
    const timestamp = new Date().toISOString();
    const item: Item = {
      id: previous?.id ?? makeId("ITEM"), name: itemDraft.name?.trim() || "Untitled item", category: itemDraft.category?.trim() || "Uncategorized",
      locationId: itemDraft.locationId || "", quantity: Math.max(0, Number(itemDraft.quantity ?? 0)), status: (itemDraft.status ?? "Available") as ItemStatus,
      tags: itemDraft.tags ?? [], notes: itemDraft.notes?.trim() || "", createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp,
      version: (previous?.version ?? 0) + 1, deletedAt: previous?.deletedAt ?? "",
    };
    const events = await saveItem(item, previous);
    setData((current) => ({ ...current, items: [...current.items.filter((entry) => entry.id !== item.id), item], history: [...events, ...current.history] }));
    setSelectedId(item.id); setDialog(null); setSyncState(sheetConfig ? "local" : syncState);
    setToast(previous ? `${item.name} updated locally` : `${item.name} added locally`);
  }

  async function archiveCurrentItem() {
    const previous = data.items.find((item) => item.id === itemDraft.id);
    if (!previous || !window.confirm(`Archive ${previous.name}? Its history will be kept.`)) return;
    const item: Item = { ...previous, status: "Archived", deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: previous.version + 1 };
    const events = await saveItem(item, previous);
    setData((current) => ({ ...current, items: [...current.items.filter((entry) => entry.id !== item.id), item], history: [...events, ...current.history] }));
    setSelectedId(visibleItems.find((entry) => entry.id !== item.id)?.id ?? ""); setDialog(null); setToast(`${item.name} archived`);
  }

  async function submitLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const previous = locationDraft.id ? data.locations.find((location) => location.id === locationDraft.id) : undefined;
    const timestamp = new Date().toISOString();
    const location: Location = { id: previous?.id ?? makeId("LOC"), name: locationDraft.name?.trim() || "Untitled location", parentId: locationDraft.parentId || "", notes: locationDraft.notes?.trim() || "", createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, version: (previous?.version ?? 0) + 1 };
    const events = await saveLocation(location, previous);
    setData((current) => ({ ...current, locations: [...current.locations.filter((entry) => entry.id !== location.id), location], history: [...events, ...current.history] }));
    setDialog(null); setToast(previous ? `${location.name} updated` : `${location.name} added`);
  }

  async function connectAndSync(config = sheetConfig) {
    if (!syncEnabled) { setToast("Sync is disabled. Turn it on before connecting."); return; }
    if (!config) { setDialog("connect"); return; }
    try {
      setSyncState("connecting"); await authorizeGoogle(config.clientId); setSyncState("syncing");
      const merged = await synchronizeSheets(config, data);
      await replaceFromSync(merged); setData(merged); setSyncState("synced"); setToast("Google Sheet and local cache are in sync");
    } catch (error) { setSyncState("error"); setToast(error instanceof Error ? error.message : "Google sync failed"); }
  }

  async function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const spreadsheetId = String(form.get("spreadsheetId") || "").trim().replace(/^.*\/spreadsheets\/d\//, "").split("/")[0];
    const config: SheetConfig = { clientId: String(form.get("clientId") || "").trim(), spreadsheetId, sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
    setDialog(null); setSheetConfigState(config); await saveSheetConfig(config); await connectAndSync(config);
  }

  async function toggleSync(enabled: boolean) {
    setSyncEnabled(enabled);
    await saveSyncEnabled(enabled);
    if (!enabled) {
      setSyncState("local");
      setToast("Sync disabled — Findry will stay entirely on this device");
    } else {
      setToast("Sync enabled — use Sync now when you want to contact Google Sheets");
    }
  }

  const attentionCount = activeItems.filter((item) => item.status === "Low stock" || item.status === "Needs repair").length;

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">Skip to inventory</a>
      <aside className="sidebar" aria-label="Primary navigation">
        <button className="brand" type="button" onClick={() => setView("inventory")} aria-label="Findry inventory home"><span>F</span><b>Findry</b></button>
        <nav>
          <button className={`nav-item ${view === "inventory" ? "active" : ""}`} type="button" onClick={() => setView("inventory")}><span aria-hidden="true">▦</span> Inventory</button>
          <button className={`nav-item ${view === "locations" ? "active" : ""}`} type="button" onClick={() => setView("locations")}><span aria-hidden="true">⌖</span> Locations</button>
          <button className={`nav-item ${view === "history" ? "active" : ""}`} type="button" onClick={() => setView("history")}><span aria-hidden="true">↺</span> History</button>
        </nav>
        <div className="sync-card">
          <div className="sync-line"><span className={`sync-dot ${!syncEnabled ? "disabled" : syncState}`} /><span>{!syncEnabled ? "Sync disabled" : syncState === "synced" ? "Sheet synchronized" : syncState === "syncing" || syncState === "connecting" ? "Connecting…" : syncState === "error" ? "Sync needs attention" : "Sync enabled"}</span></div>
          <p>{!syncEnabled ? "Device-only mode" : sheetConfig ? "Google Sheet configured" : "Google Sheets not connected"}</p>
          <label className="sync-toggle"><span>Allow web sync</span><input type="checkbox" role="switch" checked={syncEnabled} disabled={syncState === "syncing" || syncState === "connecting"} onChange={(event) => toggleSync(event.target.checked)} /><span className="toggle-track" aria-hidden="true"><span /></span></label>
          <button type="button" onClick={() => connectAndSync()} disabled={!syncEnabled || syncState === "syncing" || syncState === "connecting"}>{sheetConfig ? "Sync now" : "Connect sheet"}</button>
        </div>
      </aside>

      <section className="workspace" id="main-content" tabIndex={-1}>
        <header className="topbar"><div><p className="eyebrow">Your workshop, indexed</p><h1>{view === "inventory" ? "Inventory" : view === "locations" ? "Locations" : "Change history"}</h1></div><div className="top-actions">{syncEnabled && sheetConfig && <a className="quiet-button link-button" href={sheetConfig.sheetUrl} target="_blank" rel="noreferrer">Open sheet</a>}<button className="quiet-button" type="button" onClick={() => downloadBackup().then(() => setToast("Backup downloaded"))}>Backup</button>{view !== "history" && <button className="primary-button" type="button" onClick={view === "locations" ? openNewLocation : openNewItem}><span aria-hidden="true">＋</span> New {view === "locations" ? "location" : "item"} <kbd>N</kbd></button>}</div></header>

        {view === "inventory" && <>
          <section className="search-panel" aria-label="Search and filter inventory"><label className="search-box"><span aria-hidden="true">⌕</span><span className="sr-only">Search inventory</span><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tools, tags, IDs, or locations…" /><kbd>/</kbd></label><label><span className="sr-only">Filter by location</span><select className="filter-button" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}><option>All locations</option>{data.locations.map((location) => <option value={location.id} key={location.id}>{locationPath(location.id, data.locations)}</option>)}</select></label><label><span className="sr-only">Filter by category</span><select className="filter-button" value={category} onChange={(event) => setCategory(event.target.value)}><option>All categories</option>{categories.map((name) => <option key={name}>{name}</option>)}</select></label></section>
          <section className="summary-grid" aria-label="Inventory summary"><article><strong>{activeItems.length}</strong><span>Total items</span></article><article><strong>{data.locations.length}</strong><span>Locations</span></article><article><strong>{attentionCount}</strong><span>Need attention</span></article><article className={`sync-summary ${!syncEnabled ? "offline" : ""}`}><strong>{!syncEnabled ? "Offline" : sheetConfig ? (syncState === "synced" ? "Synced" : "Local+") : "Ready"}</strong><span>{!syncEnabled ? "Sync disabled" : sheetConfig ? "Google Sheet linked" : "Sync available"}</span></article></section>
          <section className="inventory-card"><div className="section-heading"><div><h2>All items</h2><p>{visibleItems.length} matching item{visibleItems.length === 1 ? "" : "s"}</p></div><span className="key-hint"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open</span></div><div className="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th>Location</th><th>Qty.</th><th>Status</th></tr></thead><tbody>{visibleItems.map((item, index) => <tr id={`row-${item.id}`} key={item.id} tabIndex={item.id === selectedId || (!selectedId && index === 0) ? 0 : -1} aria-selected={item.id === selectedId} onFocus={() => setSelectedId(item.id)} onClick={() => setSelectedId(item.id)} onDoubleClick={() => openEditItem(item)}><td><strong>{item.name}</strong><span className="item-id">{item.id}</span></td><td>{item.category}</td><td>{locationPath(item.locationId, data.locations)}</td><td>{item.quantity}</td><td><span className={`status ${item.status.toLowerCase().replaceAll(" ", "-")}`}>{item.status}</span></td></tr>)}</tbody></table>{!loading && visibleItems.length === 0 && <div className="empty-state"><strong>No items found</strong><span>Try another search or press N to add one.</span></div>}</div></section>
        </>}

        {view === "locations" && <section className="location-grid" aria-label="Storage locations">{data.locations.map((location) => <button className="location-card" type="button" key={location.id} onClick={() => openEditLocation(location)}><span className="location-icon" aria-hidden="true">⌖</span><span><strong>{locationPath(location.id, data.locations)}</strong><small>{activeItems.filter((item) => item.locationId === location.id).length} items · {location.notes || "No notes"}</small></span><span aria-hidden="true">›</span></button>)}</section>}

        {view === "history" && <section className="history-list" aria-label="Change history"><div className="section-heading"><div><h2>Local audit trail</h2><p>{data.history.length} changes retained on this device</p></div><span className="history-note">Append-only</span></div>{data.history.length === 0 ? <div className="empty-state"><strong>No changes yet</strong><span>Your first edit will appear here.</span></div> : data.history.map((event: HistoryEvent) => <article className="history-row" key={event.id}><span className={`history-mark ${event.action}`} aria-hidden="true">{event.action === "create" ? "+" : event.action === "delete" ? "−" : "↺"}</span><div><strong>{event.action === "create" ? "Created" : event.action === "delete" ? "Archived" : "Changed"} {event.entityType} {event.entityId}</strong><p>{event.field === "*" ? event.newValue : <><b>{event.field}</b>: {event.oldValue || "empty"} → {event.newValue || "empty"}</>}</p></div><time dateTime={event.changedAt}>{new Date(event.changedAt).toLocaleString()}</time><span className={`sync-badge ${event.synced ? "done" : ""}`}>{event.synced ? "Synced" : "Local"}</span></article>)}</section>}
      </section>

      {dialog === "item" && <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="item-dialog-title"><form ref={dialogFormRef} onSubmit={submitItem}><div className="dialog-header"><div><p className="eyebrow">{itemDraft.id ? itemDraft.id : "New record"}</p><h2 id="item-dialog-title">{itemDraft.id ? "Edit item" : "Add an item"}</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div><div className="form-grid"><label className="wide">Item name<input autoFocus required value={itemDraft.name ?? ""} onChange={(event) => setItemDraft({ ...itemDraft, name: event.target.value })} /></label><label>Category<input required list="category-list" value={itemDraft.category ?? ""} onChange={(event) => setItemDraft({ ...itemDraft, category: event.target.value })} /><datalist id="category-list">{categories.map((name) => <option key={name} value={name} />)}</datalist></label><label>Location<select value={itemDraft.locationId ?? ""} onChange={(event) => setItemDraft({ ...itemDraft, locationId: event.target.value })}><option value="">Unassigned</option>{data.locations.map((location) => <option value={location.id} key={location.id}>{locationPath(location.id, data.locations)}</option>)}</select></label><label>Quantity<input type="number" min="0" inputMode="numeric" value={itemDraft.quantity ?? 0} onChange={(event) => setItemDraft({ ...itemDraft, quantity: Number(event.target.value) })} /></label><label>Status<select value={itemDraft.status ?? "Available"} onChange={(event) => setItemDraft({ ...itemDraft, status: event.target.value as ItemStatus })}>{ITEM_STATUSES.filter((status) => status !== "Archived").map((status) => <option key={status}>{status}</option>)}</select></label><label className="wide">Tags <span>comma separated</span><input value={(itemDraft.tags ?? []).join(", ")} onChange={(event) => setItemDraft({ ...itemDraft, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></label><label className="wide">Notes<textarea rows={3} value={itemDraft.notes ?? ""} onChange={(event) => setItemDraft({ ...itemDraft, notes: event.target.value })} /></label></div><div className="dialog-footer">{itemDraft.id ? <button className="danger-button" type="button" onClick={archiveCurrentItem}>Archive item</button> : <span />}<div><button className="quiet-button" type="button" onClick={() => setDialog(null)}>Cancel <kbd>Esc</kbd></button><button className="primary-button" type="submit">Save item <kbd>{typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘S" : "Ctrl S"}</kbd></button></div></div></form></section></div>}

      {dialog === "location" && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="location-dialog-title"><form ref={dialogFormRef} onSubmit={submitLocation}><div className="dialog-header"><div><p className="eyebrow">Storage address</p><h2 id="location-dialog-title">{locationDraft.id ? "Edit location" : "New location"}</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div><div className="form-grid"><label className="wide">Name<input autoFocus required value={locationDraft.name ?? ""} onChange={(event) => setLocationDraft({ ...locationDraft, name: event.target.value })} /></label><label className="wide">Inside<select value={locationDraft.parentId ?? ""} onChange={(event) => setLocationDraft({ ...locationDraft, parentId: event.target.value })}><option value="">Top-level location</option>{data.locations.filter((location) => location.id !== locationDraft.id).map((location) => <option key={location.id} value={location.id}>{locationPath(location.id, data.locations)}</option>)}</select></label><label className="wide">Notes<textarea rows={3} value={locationDraft.notes ?? ""} onChange={(event) => setLocationDraft({ ...locationDraft, notes: event.target.value })} /></label></div><div className="dialog-footer"><span /><div><button className="quiet-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit">Save location</button></div></div></form></section></div>}

      {dialog === "connect" && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="connect-title"><form ref={dialogFormRef} onSubmit={submitConnection}><div className="dialog-header"><div><p className="eyebrow">Cloud copy</p><h2 id="connect-title">Connect Google Sheets</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div><p className="dialog-copy">Use a Google Cloud Web OAuth client and a Sheet you own. Findry will create its four tabs automatically.</p><div className="form-grid"><label className="wide">OAuth client ID<input name="clientId" required defaultValue={sheetConfig?.clientId} placeholder="123456789-abc.apps.googleusercontent.com" /></label><label className="wide">Spreadsheet URL or ID<input name="spreadsheetId" required defaultValue={sheetConfig?.spreadsheetId} placeholder="Paste the Google Sheets URL" /></label></div><div className="privacy-note">Your client ID and Sheet ID stay in this device’s local database. Google access tokens are kept only for the current session.</div><div className="dialog-footer"><span /><div><button className="quiet-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit">Authorize and sync</button></div></div></form></section></div>}

      {dialog === "help" && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title"><div className="dialog-header"><div><p className="eyebrow">Keyboard-first</p><h2 id="shortcut-title">Shortcuts</h2></div><button className="icon-button" autoFocus type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div><div className="shortcut-list">{[["/ or Ctrl/⌘ K", "Search"], ["N", "New item or location"], ["E", "Edit selected item"], ["↑ ↓ or J K", "Move selection"], ["Enter", "Open selected item"], ["Ctrl/⌘ S", "Save an open form"], ["Escape", "Close a dialog"], ["?", "Show shortcuts"]].map(([key, action]) => <div key={key}><kbd>{key}</kbd><span>{action}</span></div>)}</div></section></div>}

      <button className="help-button" type="button" onClick={() => setDialog("help")} aria-label="Show keyboard shortcuts">?</button><div className="toast" role="status" aria-live="polite" aria-atomic="true">{toast}</div>
    </main>
  );
}
