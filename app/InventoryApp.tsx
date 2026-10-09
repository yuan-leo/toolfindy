"use client";
/* eslint-disable jsx-a11y/no-autofocus -- dialogs deliberately place keyboard users at their first safe action */

import { ChangeEvent, DragEvent, FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { HistoryEvent, InventoryState, Item, ItemStatus, ITEM_STATUSES, Location, SheetConfig, locationPath, makeId } from "@/lib/inventory";
import { BackupRestoreCandidate, RECYCLE_BIN_LOCATION_ID, applySortRecommendations, createDailySnapshot, deleteLocationAndRecycle, downloadBackup, getLastItemLocation, getLatestSortDraft, getSheetConfig, getSyncEnabled, loadInventory, readBackupFile, replaceFromSync, restoreBackup, saveItem, saveLastItemLocation, saveLocation, saveSheetConfig, saveSortDraft, saveSyncEnabled } from "@/lib/local-store";
import { createSortingPrompt, parseSortRecommendations } from "@/lib/chat-sorting";
import { SortDraft, SortRecommendation } from "@/lib/sorting";

type View = "inventory" | "sorting" | "locations" | "history";
type DialogName = "item" | "batch" | "location" | "delete-location" | "restore" | "connect" | "sync-error" | "help" | null;
type InventorySortKey = "name" | "category" | "location" | "quantity" | "status";
type SortDirection = "asc" | "desc";
type LocationOption = { location: Location; depth: number; path: string };
const DEFAULT_GOOGLE_CLIENT_ID = "273102439168-tjukbbs0spr4u08k5o4psofblbr73fdu.apps.googleusercontent.com";
const IS_STANDALONE = import.meta.env.MODE === "standalone";
const emptyState: InventoryState = { items: [], locations: [], history: [] };
const blankItem = (locationId = ""): Partial<Item> => ({ name: "", category: "", locationId, quantity: 1, status: "Available", tags: [], notes: "" });
const blankLocation = (): Partial<Location> => ({ name: "", parentId: "", notes: "" });

function flattenLocationTree(locations: Location[]) {
  const knownIds = new Set(locations.map((location) => location.id));
  const children = new Map<string, Location[]>();
  locations.forEach((location) => {
    const parentId = knownIds.has(location.parentId) ? location.parentId : "";
    children.set(parentId, [...(children.get(parentId) ?? []), location]);
  });
  children.forEach((group) => group.sort((left, right) => left.name.localeCompare(right.name)));
  const result: Array<{ location: Location; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (parentId: string, depth: number) => {
    (children.get(parentId) ?? []).forEach((location) => {
      if (visited.has(location.id)) return;
      visited.add(location.id);
      result.push({ location, depth });
      visit(location.id, depth + 1);
    });
  };
  visit("", 0);
  locations.filter((location) => !visited.has(location.id)).sort((left, right) => left.name.localeCompare(right.name)).forEach((location) => {
    if (visited.has(location.id)) return;
    visited.add(location.id);
    result.push({ location, depth: 0 });
    visit(location.id, 1);
  });
  return result;
}

function wouldCreateLocationCycle(locationId: string, parentId: string, locations: Location[]) {
  const seen = new Set<string>();
  let currentId = parentId;
  while (currentId && !seen.has(currentId)) {
    if (currentId === locationId) return true;
    seen.add(currentId);
    currentId = locations.find((location) => location.id === currentId)?.parentId ?? "";
  }
  return false;
}

function filterAndRankLocationOptions(options: LocationOption[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return options;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return options.map((option, originalIndex) => {
    const matchingLevels = option.path.split(" / ").map((name, level) => ({ name, level, normalized: name.toLocaleLowerCase() }))
      .filter(({ normalized }) => normalized.includes(needle));
    const bottommostMatch = matchingLevels.at(-1);
    return bottommostMatch ? {
      option,
      originalIndex,
      matchLevel: bottommostMatch.level,
      matchName: bottommostMatch.name,
      startsWithSearch: bottommostMatch.normalized.startsWith(needle),
    } : null;
  }).filter((match): match is NonNullable<typeof match> => Boolean(match)).sort((left, right) => {
    if (left.startsWithSearch !== right.startsWithSearch) return left.startsWithSearch ? -1 : 1;
    return right.matchLevel - left.matchLevel
      || collator.compare(left.matchName, right.matchName)
      || collator.compare(left.option.path, right.option.path)
      || left.originalIndex - right.originalIndex;
  }).map(({ option }) => option);
}

function LocationCombobox({ value, onChange, options, emptyLabel, ariaLabel, disabled = false }: {
  value: string;
  onChange: (locationId: string) => void;
  options: LocationOption[];
  emptyLabel: string;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selectedPath = options.find(({ location }) => location.id === value)?.path ?? "";
  const filteredOptions = useMemo(() => filterAndRankLocationOptions(options, query), [options, query]);
  const includeEmptyOption = !query.trim();
  const selectableCount = filteredOptions.length + (includeEmptyOption ? 1 : 0);

  function openList() {
    if (disabled) return;
    setQuery("");
    setActiveIndex(value ? Math.max(1, options.findIndex(({ location }) => location.id === value) + 1) : 0);
    setOpen(true);
  }

  function choose(locationId: string) {
    onChange(locationId);
    setQuery("");
    setOpen(false);
  }

  function chooseActive() {
    if (!selectableCount) return;
    if (includeEmptyOption && activeIndex === 0) choose("");
    else choose(filteredOptions[activeIndex - (includeEmptyOption ? 1 : 0)]?.location.id ?? "");
  }

  return <div className={`location-combobox${open ? " open" : ""}`}>
    <div className="location-combobox-control">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && selectableCount ? `${listboxId}-option-${activeIndex}` : undefined}
        autoComplete="off"
        disabled={disabled}
        value={open ? query : selectedPath}
        placeholder={emptyLabel}
        onFocus={() => { if (!open) openList(); }}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); if (!open) openList(); else setActiveIndex((index) => Math.min(index + 1, Math.max(0, selectableCount - 1))); }
          else if (event.key === "ArrowUp") { event.preventDefault(); if (!open) openList(); else setActiveIndex((index) => Math.max(0, index - 1)); }
          else if (event.key === "Enter" && open) { event.preventDefault(); chooseActive(); }
          else if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setQuery(""); setOpen(false); }
          else if (event.key === "Tab") { setQuery(""); setOpen(false); }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.parentElement?.contains(event.relatedTarget)) { setQuery(""); setOpen(false); }
        }}
      />
      <button type="button" className="location-combobox-toggle" aria-label={`${open ? "Close" : "Open"} ${ariaLabel}`} disabled={disabled} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => {
        if (open) { setQuery(""); setOpen(false); }
        else { openList(); inputRef.current?.focus(); }
      }}>⌄</button>
    </div>
    {open && <ul id={listboxId} className="location-combobox-list" role="listbox" aria-label={`${ariaLabel} options`}>
      {includeEmptyOption && <li id={`${listboxId}-option-0`} role="option" aria-selected={!value} className={`location-combobox-option empty-option${activeIndex === 0 ? " active" : ""}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(0)} onClick={() => choose("")}>{emptyLabel}</li>}
      {filteredOptions.map((option, index) => {
        const optionIndex = index + (includeEmptyOption ? 1 : 0);
        return <li id={`${listboxId}-option-${optionIndex}`} key={option.location.id} role="option" aria-selected={option.location.id === value} className={`location-combobox-option${activeIndex === optionIndex ? " active" : ""}`} style={{ paddingLeft: query.trim() ? undefined : `${12 + option.depth * 16}px` }} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveIndex(optionIndex)} onClick={() => choose(option.location.id)}>
          <span>{query.trim() ? option.path : option.location.name}</span>
          {!query.trim() && option.depth > 0 && <small>{option.path}</small>}
        </li>;
      })}
      {!filteredOptions.length && !includeEmptyOption && <li className="location-combobox-empty">No locations match “{query.trim()}”</li>}
    </ul>}
  </div>;
}

async function copyText(value: string) {
  try { await navigator.clipboard.writeText(value); return; }
  catch {
    const textarea = document.createElement("textarea");
    textarea.value = value; textarea.style.position = "fixed"; textarea.style.opacity = "0";
    document.body.appendChild(textarea); textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard access was blocked. Try again after allowing clipboard access for this site.");
  }
}

export default function InventoryApp() {
  const [data, setData] = useState<InventoryState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("inventory");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All categories");
  const [locationFilter, setLocationFilter] = useState("All locations");
  const [selectedId, setSelectedId] = useState("");
  const [checkedItemIds, setCheckedItemIds] = useState<Set<string>>(() => new Set());
  const [bulkLocationId, setBulkLocationId] = useState("");
  const [bulkMovePending, setBulkMovePending] = useState(false);
  const [inventorySort, setInventorySort] = useState<{ key: InventorySortKey; direction: SortDirection }>({ key: "name", direction: "asc" });
  const [dialog, setDialog] = useState<DialogName>(null);
  const [itemDraft, setItemDraft] = useState<Partial<Item>>(blankItem());
  const [itemDetailsExpanded, setItemDetailsExpanded] = useState(false);
  const [lastItemLocationId, setLastItemLocationId] = useState("");
  const [batchNames, setBatchNames] = useState("");
  const [batchTags, setBatchTags] = useState("");
  const [batchLocationId, setBatchLocationId] = useState("");
  const [locationDraft, setLocationDraft] = useState<Partial<Location>>(blankLocation());
  const [deleteLocationTarget, setDeleteLocationTarget] = useState<Location>();
  const [locationDeletePending, setLocationDeletePending] = useState(false);
  const [locationReturnDialog, setLocationReturnDialog] = useState<"item" | "batch" | null>(null);
  const [draggedLocationId, setDraggedLocationId] = useState("");
  const [dragOverLocationId, setDragOverLocationId] = useState("");
  const [restoreCandidate, setRestoreCandidate] = useState<BackupRestoreCandidate>();
  const [restorePending, setRestorePending] = useState(false);
  const [sheetConfig, setSheetConfigState] = useState<SheetConfig>();
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncState, setSyncState] = useState<"local" | "connecting" | "syncing" | "synced" | "error">("local");
  const [syncError, setSyncError] = useState("");
  const [sortDraft, setSortDraft] = useState<SortDraft>();
  const [sortBusy, setSortBusy] = useState(false);
  const [sortError, setSortError] = useState("");
  const [chatResponse, setChatResponse] = useState("");
  const [toast, setToast] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogFormRef = useRef<HTMLFormElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const finishLocalStartup = (inventory: InventoryState, storedLocationId: string, storedSortDraft: SortDraft | undefined) => {
      setData(inventory);
      setLastItemLocationId(storedLocationId);
      setSortDraft(storedSortDraft);
      setSelectedId(inventory.items.find((item) => !item.deletedAt)?.id ?? "");
      setLoading(false);
      createDailySnapshot().catch(() => undefined);
    };
    const startup = IS_STANDALONE
      ? Promise.all([loadInventory(), getLastItemLocation(), getLatestSortDraft()]).then(([inventory, storedLocationId, storedSortDraft]) => {
          finishLocalStartup(inventory, storedLocationId, storedSortDraft);
        })
      : Promise.all([loadInventory(), getSheetConfig(), getSyncEnabled(), getLastItemLocation(), getLatestSortDraft()]).then(([inventory, config, storedSyncEnabled, storedLocationId, storedSortDraft]) => {
          setSheetConfigState(config);
          setSyncEnabled(storedSyncEnabled);
          finishLocalStartup(inventory, storedLocationId, storedSortDraft);
        });
    startup.catch((error) => {
      setToast(`Local storage could not start: ${error.message}`);
      setLoading(false);
    });
    navigator.storage?.persist?.().catch(() => undefined);
    if (!IS_STANDALONE && window.location.protocol !== "file:" && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeItems = useMemo(() => data.items.filter((item) => !item.deletedAt), [data.items]);
  const activeLocations = useMemo(() => data.locations.filter((location) => !location.deletedAt), [data.locations]);
  const sortingLocation = useMemo(() => activeLocations.find((location) => location.name.trim().toLowerCase() === "to be sorted"), [activeLocations]);
  const sortingItems = useMemo(() => sortingLocation ? activeItems.filter((item) => item.locationId === sortingLocation.id) : [], [activeItems, sortingLocation]);
  const categories = useMemo(() => [...new Set(activeItems.map((item) => item.category).filter(Boolean))].sort(), [activeItems]);
  const locationTree = useMemo(() => flattenLocationTree(activeLocations), [activeLocations]);
  const locationOptions = useMemo(() => flattenLocationTree(activeLocations).map(({ location, depth }) => ({
    location,
    depth,
    path: locationPath(location.id, activeLocations),
  })), [activeLocations]);
  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = activeItems.filter((item) => {
      const matchesQuery = !needle || [item.id, item.name, item.category, locationPath(item.locationId, activeLocations), item.tags.join(" "), item.notes].join(" ").toLowerCase().includes(needle);
      return matchesQuery && (category === "All categories" || item.category === category) && (locationFilter === "All locations" || item.locationId === locationFilter);
    });
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const sortValue = (item: Item) => {
      if (inventorySort.key === "location") return locationPath(item.locationId, activeLocations);
      if (inventorySort.key === "name") return item.name;
      if (inventorySort.key === "category") return item.category;
      if (inventorySort.key === "quantity") return item.quantity;
      return item.status;
    };
    return [...filtered].sort((left, right) => {
      const leftValue = sortValue(left);
      const rightValue = sortValue(right);
      const result = inventorySort.key === "quantity"
        ? Number(leftValue) - Number(rightValue)
        : collator.compare(String(leftValue), String(rightValue));
      const directed = inventorySort.direction === "asc" ? result : -result;
      return directed || collator.compare(left.name, right.name);
    });
  }, [activeItems, activeLocations, category, inventorySort, locationFilter, query]);
  const selectedIndex = Math.max(0, visibleItems.findIndex((item) => item.id === selectedId));
  const checkedItems = useMemo(() => activeItems.filter((item) => checkedItemIds.has(item.id)), [activeItems, checkedItemIds]);
  const allVisibleChecked = visibleItems.length > 0 && visibleItems.every((item) => checkedItemIds.has(item.id));

  function openNewItem() {
    const rememberedLocation = activeLocations.some((location) => location.id === lastItemLocationId) ? lastItemLocationId : "";
    setItemDraft(blankItem(rememberedLocation)); setItemDetailsExpanded(false); setDialog("item");
  }
  function openEditItem(item = data.items.find((candidate) => candidate.id === selectedId)) { if (item) { setItemDraft({ ...item }); setItemDetailsExpanded(true); setDialog("item"); } }
  function openBatchItems() {
    const rememberedLocation = activeLocations.some((location) => location.id === lastItemLocationId) ? lastItemLocationId : "";
    setBatchNames(""); setBatchTags(""); setBatchLocationId(rememberedLocation); setDialog("batch");
  }
  function openNewLocation(returnTo: "item" | "batch" | null = null) { setLocationReturnDialog(returnTo); setLocationDraft(blankLocation()); setDialog("location"); }
  function openEditLocation(location: Location) { setLocationReturnDialog(null); setLocationDraft({ ...location }); setDialog("location"); }
  function closeLocationDialog() { const returnTo = locationReturnDialog; setLocationReturnDialog(null); setDialog(returnTo); }
  function requestDeleteLocation() {
    const target = activeLocations.find((location) => location.id === locationDraft.id);
    if (!target) return;
    if (target.id === RECYCLE_BIN_LOCATION_ID || target.name.trim().toLowerCase() === "recycle bin") { setToast("The Recycle bin is a protected location"); return; }
    setDeleteLocationTarget(target); setLocationDeletePending(false); setDialog("delete-location");
  }
  function cancelDeleteLocation() { if (locationDeletePending) return; setDeleteLocationTarget(undefined); setDialog("location"); }
  function cancelRestore() {
    if (restorePending) return;
    setRestoreCandidate(undefined); setDialog(null);
    if (restoreInputRef.current) restoreInputRef.current.value = "";
  }
  function moveSelection(delta: number) {
    if (!visibleItems.length) return;
    const next = Math.min(visibleItems.length - 1, Math.max(0, selectedIndex + delta));
    setSelectedId(visibleItems[next].id);
    requestAnimationFrame(() => document.getElementById(`row-${visibleItems[next].id}`)?.focus());
  }

  function toggleInventorySort(key: InventorySortKey) {
    setInventorySort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  }

  function toggleCheckedItem(itemId: string) {
    setCheckedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleAllVisibleItems() {
    setCheckedItemIds((current) => {
      const next = new Set(current);
      if (allVisibleChecked) visibleItems.forEach((item) => next.delete(item.id));
      else visibleItems.forEach((item) => next.add(item.id));
      return next;
    });
  }

  async function moveCheckedItems() {
    if (!checkedItems.length) { setToast("Select at least one item"); return; }
    const destination = activeLocations.find((location) => location.id === bulkLocationId);
    if (!destination) { setToast("Choose a destination location"); return; }
    setBulkMovePending(true);
    try {
      const movedItems: Item[] = [];
      const events: HistoryEvent[] = [];
      for (const [index, previous] of checkedItems.entries()) {
        if (previous.locationId === destination.id) continue;
        const item: Item = { ...previous, locationId: destination.id, updatedAt: new Date(Date.now() + index).toISOString(), version: previous.version + 1 };
        movedItems.push(item);
        events.push(...await saveItem(item, previous));
      }
      if (!movedItems.length) {
        setToast(`Selected items are already in ${locationPath(destination.id, activeLocations)}`);
        return;
      }
      const movedIds = new Set(movedItems.map((item) => item.id));
      setData((current) => ({ ...current, items: [...current.items.filter((item) => !movedIds.has(item.id)), ...movedItems], history: [...events, ...current.history] }));
      setCheckedItemIds(new Set());
      setSyncState(sheetConfig ? "local" : syncState);
      setToast(`${movedItems.length} item${movedItems.length === 1 ? "" : "s"} moved to ${locationPath(destination.id, activeLocations)}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The selected items could not be moved");
    } finally {
      setBulkMovePending(false);
    }
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
      if (event.key === "Escape" && dialog) { event.preventDefault(); if (dialog === "location") closeLocationDialog(); else if (dialog === "delete-location") cancelDeleteLocation(); else if (dialog === "restore") cancelRestore(); else setDialog(null); return; }
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
      else if (event.key.toLowerCase() === "n") { event.preventDefault(); if (view === "locations") openNewLocation(); else openNewItem(); }
      else if (event.key.toLowerCase() === "b" && view === "inventory") { event.preventDefault(); openBatchItems(); }
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
    if (!previous) { setLastItemLocationId(item.locationId); await saveLastItemLocation(item.locationId); }
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

  async function submitBatchItems(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const names = batchNames.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    if (!names.length) { setToast("Enter at least one item name"); return; }
    const tags = batchTags.split(",").map((tag) => tag.trim()).filter(Boolean);
    const items: Item[] = [];
    const events: HistoryEvent[] = [];
    for (const [index, name] of names.entries()) {
      const timestamp = new Date(Date.now() + index).toISOString();
      const item: Item = {
        id: makeId("ITEM"), name, category: "Uncategorized", locationId: batchLocationId, quantity: 1, status: "Available", tags, notes: "",
        createdAt: timestamp, updatedAt: timestamp, version: 1, deletedAt: "",
      };
      const itemEvents = await saveItem(item);
      items.push(item);
      events.push(...itemEvents);
    }
    setData((current) => ({ ...current, items: [...current.items, ...items], history: [...events.reverse(), ...current.history] }));
    setLastItemLocationId(batchLocationId); await saveLastItemLocation(batchLocationId);
    setSelectedId(items[0].id); setDialog(null); setSyncState(sheetConfig ? "local" : syncState);
    const destination = batchLocationId ? locationPath(batchLocationId, activeLocations) : "Unassigned";
    setToast(`${items.length} item${items.length === 1 ? "" : "s"} added to ${destination}`);
  }

  async function selectBackupFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const candidate = await readBackupFile(file);
      setRestoreCandidate(candidate); setRestorePending(false); setDialog("restore");
    } catch (error) {
      event.target.value = "";
      setToast(error instanceof Error ? error.message : "That backup could not be read");
    }
  }

  async function confirmRestore() {
    if (!restoreCandidate || restorePending) return;
    setRestorePending(true);
    try {
      const restored = await restoreBackup(restoreCandidate);
      setData(restored);
      setSortDraft(undefined); setSortError("");
      setSelectedId(restored.items.find((item) => !item.deletedAt)?.id ?? "");
      setLastItemLocationId(""); setLocationFilter("All locations"); setCategory("All categories"); setQuery(""); setView("inventory");
      setSyncState("local"); setSyncError("");
      const restoredName = restoreCandidate.fileName;
      setRestoreCandidate(undefined); setRestorePending(false); setDialog(null);
      if (restoreInputRef.current) restoreInputRef.current.value = "";
      setToast(`${restoredName} restored — ${restored.items.filter((item) => !item.deletedAt).length} active items loaded`);
    } catch (error) {
      setRestorePending(false);
      setToast(error instanceof Error ? error.message : "The backup could not be restored");
    }
  }

  async function submitLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const previous = locationDraft.id ? data.locations.find((location) => location.id === locationDraft.id) : undefined;
    const timestamp = new Date().toISOString();
    const location: Location = { id: previous?.id ?? makeId("LOC"), name: locationDraft.name?.trim() || "Untitled location", parentId: locationDraft.parentId || "", notes: locationDraft.notes?.trim() || "", createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, version: (previous?.version ?? 0) + 1, deletedAt: previous?.deletedAt ?? "" };
    const events = await saveLocation(location, previous);
    setData((current) => ({ ...current, locations: [...current.locations.filter((entry) => entry.id !== location.id), location], history: [...events, ...current.history] }));
    if (!previous && locationReturnDialog) {
      if (locationReturnDialog === "item") setItemDraft((current) => ({ ...current, locationId: location.id }));
      else setBatchLocationId(location.id);
      const returnDialog = locationReturnDialog;
      setLocationReturnDialog(null); setDialog(returnDialog); setToast(`${location.name} added and selected`);
    } else {
      setLocationReturnDialog(null); setDialog(null); setToast(previous ? `${location.name} updated` : `${location.name} added`);
    }
  }

  async function confirmDeleteLocation() {
    const target = deleteLocationTarget;
    if (!target || locationDeletePending) return;
    setLocationDeletePending(true);
    const recycleBinCandidate = data.locations.find((location) => location.id === RECYCLE_BIN_LOCATION_ID)
      ?? activeLocations.find((location) => location.name.trim().toLowerCase() === "recycle bin");
    const affectedItems = data.items.filter((item) => item.locationId === target.id);
    const childLocations = activeLocations.filter((location) => location.parentId === target.id);
    try {
      const result = await deleteLocationAndRecycle(target, recycleBinCandidate, affectedItems, childLocations);
      const changedItemIds = new Set(result.movedItems.map((item) => item.id));
      const changedLocationIds = new Set([result.recycleBin.id, result.deletedLocation.id, ...result.movedChildren.map((location) => location.id)]);
      setData((current) => ({
        ...current,
        items: [...current.items.filter((item) => !changedItemIds.has(item.id)), ...result.movedItems],
        locations: [...current.locations.filter((location) => !changedLocationIds.has(location.id)), result.recycleBin, result.deletedLocation, ...result.movedChildren],
        history: [...result.events, ...current.history],
      }));
      if (lastItemLocationId === target.id) { setLastItemLocationId(result.recycleBin.id); await saveLastItemLocation(result.recycleBin.id); }
      if (locationFilter === target.id) setLocationFilter("All locations");
      setDeleteLocationTarget(undefined); setLocationDeletePending(false); setLocationDraft(blankLocation()); setDialog(null); setSyncState(sheetConfig ? "local" : syncState);
      const itemText = `${result.movedItems.length} item${result.movedItems.length === 1 ? "" : "s"} moved to Recycle bin`;
      const childText = result.movedChildren.length ? `; ${result.movedChildren.length} child location${result.movedChildren.length === 1 ? "" : "s"} moved up one level` : "";
      setToast(`${target.name} deleted — ${itemText}${childText}`);
    } catch (error) {
      setLocationDeletePending(false);
      setToast(error instanceof Error ? error.message : "The location could not be deleted");
    }
  }

  async function moveLocation(locationId: string, parentId: string) {
    const previous = data.locations.find((location) => location.id === locationId);
    if (!previous || previous.parentId === parentId) { setDraggedLocationId(""); setDragOverLocationId(""); return; }
    if (wouldCreateLocationCycle(locationId, parentId, activeLocations)) { setToast("A location cannot be moved inside itself or one of its children"); setDraggedLocationId(""); setDragOverLocationId(""); return; }
    const location: Location = { ...previous, parentId, updatedAt: new Date().toISOString(), version: previous.version + 1 };
    const events = await saveLocation(location, previous);
    setData((current) => ({ ...current, locations: [...current.locations.filter((entry) => entry.id !== location.id), location], history: [...events, ...current.history] }));
    setDraggedLocationId(""); setDragOverLocationId(""); setSyncState(sheetConfig ? "local" : syncState);
    setToast(parentId ? `${location.name} moved inside ${locationPath(parentId, activeLocations)}` : `${location.name} moved to top level`);
  }

  function startLocationDrag(event: DragEvent<HTMLElement>, locationId: string) {
    setDraggedLocationId(locationId); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", locationId);
  }

  function allowLocationDrop(event: DragEvent<HTMLElement>, parentId: string) {
    const sourceId = draggedLocationId || event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === parentId || wouldCreateLocationCycle(sourceId, parentId, activeLocations)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverLocationId(parentId || "__top__");
  }

  function dropLocation(event: DragEvent<HTMLElement>, parentId: string) {
    event.preventDefault();
    const sourceId = draggedLocationId || event.dataTransfer.getData("text/plain");
    if (sourceId) void moveLocation(sourceId, parentId);
  }

  async function connectAndSync(config = sheetConfig) {
    if (IS_STANDALONE) return;
    if (!syncEnabled) { setToast("Sync is disabled. Turn it on before connecting."); return; }
    if (!config) { setDialog("connect"); return; }
    try {
      const { authorizeGoogle, synchronizeSheets } = await import("@/lib/google-sheets");
      setSyncError("");
      setSyncState("connecting"); await authorizeGoogle(config.clientId); setSyncState("syncing");
      const merged = await synchronizeSheets(config, data);
      await replaceFromSync(merged); setData(merged); setSortDraft(undefined); setSortError(""); setSyncState("synced"); setToast("Google Sheet and local cache are in sync");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google sync failed";
      setSyncState("error"); setSyncError(message); setDialog("sync-error"); setToast("Google sync needs attention");
    }
  }

  async function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const spreadsheetId = String(form.get("spreadsheetId") || "").trim().replace(/^.*\/spreadsheets\/d\//, "").split("/")[0];
    if (!/^[a-z0-9_-]{20,}$/i.test(spreadsheetId)) { setToast("Paste a valid Google Sheets link or spreadsheet ID"); return; }
    const config: SheetConfig = { clientId: String(form.get("clientId") || "").trim(), spreadsheetId, sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
    setDialog(null); setSheetConfigState(config); await saveSheetConfig(config); await connectAndSync(config);
  }

  async function toggleSync(enabled: boolean) {
    setSyncEnabled(enabled);
    await saveSyncEnabled(enabled);
    if (!enabled) {
      setSyncState("local"); setSyncError("");
      setToast("Sync disabled — Tool Findy will stay entirely on this device");
    } else {
      setToast("Sync enabled — use Sync now when you want to contact Google Sheets");
    }
  }

  async function copySortingChatPrompt() {
    if (!sortingLocation || !sortingItems.length) return;
    setSortError("");
    try {
      await copyText(createSortingPrompt(data.items, data.locations, sortingLocation.id));
      setToast("Sorting prompt copied — paste it into the chat of your choice");
    } catch (error) {
      setSortError(error instanceof Error ? error.message : "The sorting prompt could not be copied.");
    }
  }

  async function pasteSortingChatResponse() {
    try {
      const value = await navigator.clipboard.readText();
      setChatResponse(value); setSortError("");
      setToast("Chat response pasted — load it when ready");
    } catch {
      setToast("Clipboard access was blocked — click the response box and press Ctrl+V");
    }
  }

  async function loadSortingChatResponse() {
    if (!sortingLocation || !chatResponse.trim() || sortBusy) return;
    setSortBusy(true); setSortError("");
    try {
      const draft = parseSortRecommendations(chatResponse, data.items, data.locations, sortingLocation.id);
      await saveSortDraft(draft);
      setSortDraft(draft);
      setChatResponse("");
      setToast(`${draft.recommendations.length} sorting recommendations ready to review`);
    } catch (error) {
      setSortError(error instanceof Error ? error.message : "The pasted recommendations could not be loaded.");
    } finally {
      setSortBusy(false);
    }
  }

  async function updateSortRecommendation(itemId: string, patch: Partial<SortRecommendation>) {
    if (!sortDraft) return;
    const updated = { ...sortDraft, recommendations: sortDraft.recommendations.map((row) => row.itemId === itemId ? { ...row, ...patch } : row) };
    setSortDraft(updated);
    await saveSortDraft(updated);
  }

  async function updateProposedLocation(proposalId: string, patch: { name?: string; parentId?: string }) {
    if (!sortDraft) return;
    const updated = { ...sortDraft, proposedLocations: sortDraft.proposedLocations.map((proposal) => proposal.id === proposalId ? { ...proposal, ...patch } : proposal) };
    setSortDraft(updated);
    await saveSortDraft(updated);
  }

  async function applyAcceptedSorting() {
    if (!sortDraft || sortBusy) return;
    const acceptedCount = sortDraft.recommendations.filter((row) => row.reviewStatus === "accepted").length;
    if (!acceptedCount) return;
    setSortBusy(true); setSortError("");
    try {
      const result = await applySortRecommendations(sortDraft, data);
      const movedIds = new Set(result.movedItems.map((item) => item.id));
      setData((current) => ({
        items: [...current.items.filter((item) => !movedIds.has(item.id)), ...result.movedItems],
        locations: [...current.locations, ...result.createdLocations],
        history: [...result.events, ...current.history],
      }));
      setSortDraft(undefined);
      if (!IS_STANDALONE && sheetConfig) setSyncState("local");
      const staleText = result.staleItemIds.length ? ` ${result.staleItemIds.length} changed item${result.staleItemIds.length === 1 ? " was" : "s were"} left for review.` : "";
      setToast(`${result.movedItems.length} item${result.movedItems.length === 1 ? "" : "s"} sorted locally${IS_STANDALONE ? "." : " and ready to sync."}${staleText}`);
    } catch (error) {
      setSortError(error instanceof Error ? error.message : "Accepted recommendations could not be applied.");
    } finally {
      setSortBusy(false);
    }
  }

  const attentionCount = activeItems.filter((item) => item.status === "Low stock" || item.status === "Needs repair").length;
  const batchItemCount = batchNames.split(/\r?\n/).map((name) => name.trim()).filter(Boolean).length;
  const acceptedSortCount = sortDraft?.recommendations.filter((row) => row.reviewStatus === "accepted").length ?? 0;

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">Skip to inventory</a>
      <aside className="sidebar" aria-label="Primary navigation">
        <button className="brand" type="button" onClick={() => setView("inventory")} aria-label="Tool Findy inventory home"><span>T</span><b>Tool Findy</b></button>
        <nav>
          <button className={`nav-item ${view === "inventory" ? "active" : ""}`} type="button" onClick={() => setView("inventory")}><span aria-hidden="true">▦</span> Inventory</button>
          <button className={`nav-item ${view === "sorting" ? "active" : ""}`} type="button" onClick={() => setView("sorting")}><span aria-hidden="true">✦</span> Sort inbox{sortingItems.length > 0 && <b className="nav-count">{sortingItems.length}</b>}</button>
          <button className={`nav-item ${view === "locations" ? "active" : ""}`} type="button" onClick={() => setView("locations")}><span aria-hidden="true">⌖</span> Locations</button>
          <button className={`nav-item ${view === "history" ? "active" : ""}`} type="button" onClick={() => setView("history")}><span aria-hidden="true">↺</span> History</button>
        </nav>
        {IS_STANDALONE ? <div className="sync-card standalone-card">
          <div className="sync-line"><span className="sync-dot" /><span>Standalone local edition</span></div>
          <p>Saved only in this browser profile</p>
        </div> : <div className="sync-card">
          <div className="sync-line"><span className={`sync-dot ${!syncEnabled ? "disabled" : syncState}`} /><span>{!syncEnabled ? "Sync disabled" : syncState === "synced" ? "Sheet synchronized" : syncState === "syncing" || syncState === "connecting" ? "Connecting…" : syncState === "error" ? "Sync needs attention" : "Sync enabled"}</span></div>
          <p>{!syncEnabled ? "Device-only mode" : sheetConfig ? "Google Sheet configured" : "Google Sheets not connected"}</p>
          <label className="sync-toggle"><span>Allow web sync</span><input type="checkbox" role="switch" checked={syncEnabled} disabled={syncState === "syncing" || syncState === "connecting"} onChange={(event) => toggleSync(event.target.checked)} /><span className="toggle-track" aria-hidden="true"><span /></span></label>
          <button type="button" onClick={() => connectAndSync()} disabled={!syncEnabled || syncState === "syncing" || syncState === "connecting"}>{sheetConfig ? "Sync now" : "Connect sheet"}</button>
          {syncError && <button className="sync-error-button" type="button" onClick={() => setDialog("sync-error")}>View sync error</button>}
        </div>}
      </aside>

      <section className="workspace" id="main-content" tabIndex={-1}>
        <header className="topbar"><div><p className="eyebrow">{IS_STANDALONE ? "Standalone local edition" : "Your workshop, indexed"}</p><h1>{view === "inventory" ? "Inventory" : view === "sorting" ? "Sorting inbox" : view === "locations" ? "Locations" : "Change history"}</h1></div><div className="top-actions">
          {!IS_STANDALONE && syncEnabled && sheetConfig && <a className="quiet-button link-button" href={sheetConfig.sheetUrl} target="_blank" rel="noreferrer">Open sheet</a>}
          <button className="quiet-button" type="button" onClick={() => downloadBackup().then(() => setToast("Backup downloaded"))}>Backup</button>
          <input ref={restoreInputRef} className="sr-only" type="file" accept=".json,application/json" onChange={selectBackupFile} tabIndex={-1} aria-hidden="true" />
          <button className="quiet-button restore-button" type="button" onClick={() => restoreInputRef.current?.click()}><span aria-hidden="true">↥</span> Restore</button>
          {view === "inventory" && <button className="quiet-button batch-button" type="button" onClick={openBatchItems}><span aria-hidden="true">≡＋</span> Batch add <kbd>B</kbd></button>}
          {(view === "inventory" || view === "locations") && <button className="primary-button" type="button" onClick={() => view === "locations" ? openNewLocation() : openNewItem()}><span aria-hidden="true">＋</span> New {view === "locations" ? "location" : "item"} <kbd>N</kbd></button>}
        </div></header>

        {view === "inventory" && <>
          <section className="search-panel" aria-label="Search and filter inventory"><label className="search-box"><span aria-hidden="true">⌕</span><span className="sr-only">Search inventory</span><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tools, tags, IDs, or locations…" /><kbd>/</kbd></label><label><span className="sr-only">Filter by location</span><select className="filter-button" value={locationFilter} onChange={(event) => setLocationFilter(event.target.value)}><option>All locations</option>{locationOptions.map(({ location, path }) => <option value={location.id} key={location.id}>{path}</option>)}</select></label><label><span className="sr-only">Filter by category</span><select className="filter-button" value={category} onChange={(event) => setCategory(event.target.value)}><option>All categories</option>{categories.map((name) => <option key={name}>{name}</option>)}</select></label></section>
          <section className="summary-grid" aria-label="Inventory summary"><article><strong>{activeItems.length}</strong><span>Total items</span></article><article><strong>{activeLocations.length}</strong><span>Locations</span></article><article><strong>{attentionCount}</strong><span>Need attention</span></article>{IS_STANDALONE ? <article className="sync-summary offline"><strong>Standalone</strong><span>Saved in this browser</span></article> : <article className={`sync-summary ${!syncEnabled ? "offline" : ""}`}><strong>{!syncEnabled ? "Offline" : sheetConfig ? (syncState === "synced" ? "Synced" : "Local+") : "Ready"}</strong><span>{!syncEnabled ? "Sync disabled" : sheetConfig ? "Google Sheet linked" : "Sync available"}</span></article>}</section>
          <section className="inventory-card"><div className="section-heading"><div><h2>All items</h2><p>{visibleItems.length} matching item{visibleItems.length === 1 ? "" : "s"}</p></div><span className="key-hint"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>Enter</kbd> open</span></div>
            <div className={`bulk-move-bar ${checkedItems.length ? "active" : ""}`} aria-live="polite">
              <strong>{checkedItems.length} selected</strong>
              <label><span className="sr-only">Move selected items to location</span><LocationCombobox value={bulkLocationId} onChange={setBulkLocationId} options={locationOptions} emptyLabel="Choose destination…" ariaLabel="Move selected items to location" disabled={!checkedItems.length || bulkMovePending} /></label>
              <button className="primary-button" type="button" disabled={!checkedItems.length || !bulkLocationId || bulkMovePending} onClick={() => void moveCheckedItems()}>{bulkMovePending ? "Moving…" : "Move selected"}</button>
              {checkedItems.length > 0 && <button className="quiet-button" type="button" disabled={bulkMovePending} onClick={() => setCheckedItemIds(new Set())}>Clear</button>}
            </div>
            <div className="table-wrap"><table><thead><tr>
              <th className="selection-column" scope="col"><input type="checkbox" checked={allVisibleChecked} onChange={toggleAllVisibleItems} aria-label={allVisibleChecked ? "Unselect all visible items" : "Select all visible items"} /></th>
              {([["name", "Item"], ["category", "Category"], ["location", "Location"], ["quantity", "Qty."], ["status", "Status"]] as Array<[InventorySortKey, string]>).map(([key, label]) => <th key={key} scope="col" aria-sort={inventorySort.key === key ? (inventorySort.direction === "asc" ? "ascending" : "descending") : "none"}><button className="sort-button" type="button" onClick={() => toggleInventorySort(key)}>{label}<span aria-hidden="true">{inventorySort.key === key ? (inventorySort.direction === "asc" ? "▲" : "▼") : "↕"}</span></button></th>)}
            </tr></thead><tbody>{visibleItems.map((item, index) => <tr id={`row-${item.id}`} key={item.id} tabIndex={item.id === selectedId || (!selectedId && index === 0) ? 0 : -1} aria-selected={item.id === selectedId} onFocus={() => setSelectedId(item.id)} onClick={() => setSelectedId(item.id)} onDoubleClick={() => openEditItem(item)}><td className="selection-column"><input type="checkbox" checked={checkedItemIds.has(item.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleCheckedItem(item.id)} aria-label={`Select ${item.name}`} /></td><td><strong>{item.name}</strong><span className="item-id">{item.id}</span></td><td>{item.category}</td><td>{locationPath(item.locationId, activeLocations)}</td><td>{item.quantity}</td><td><span className={`status ${item.status.toLowerCase().replaceAll(" ", "-")}`}>{item.status}</span></td></tr>)}</tbody></table>{!loading && visibleItems.length === 0 && <div className="empty-state"><strong>No items found</strong><span>Try another search or press N to add one.</span></div>}</div>
          </section>
        </>}

        {view === "sorting" && <section className="sorting-workspace" aria-labelledby="sorting-title">
          {!sortingLocation ? <div className="sorting-empty"><span aria-hidden="true">⌖</span><h2 id="sorting-title">No “to be sorted” location found</h2><p>Create or rename a normal location to <strong>to be sorted</strong>. Items added there will appear here automatically.</p></div> : !sortingItems.length ? <div className="sorting-empty"><span aria-hidden="true">✓</span><h2 id="sorting-title">The sorting inbox is clear</h2><p>Add or move items into <strong>{sortingLocation.name}</strong> whenever you want them reviewed together.</p></div> : <>
            <div className="sorting-intro"><div><p className="eyebrow">{sortingItems.length} item{sortingItems.length === 1 ? "" : "s"} waiting</p><h2 id="sorting-title">Bring your own chat</h2><p>Copy a ready-made prompt, paste it into any capable chat, then bring the JSON response back here for review. Tool Findy makes no AI API requests.</p></div><button className="primary-button" type="button" onClick={() => void copySortingChatPrompt()}><span aria-hidden="true">▣</span>Copy chat prompt</button></div>
            <p className="sorting-privacy">The copied prompt contains item names, categories, tags, notes, your location hierarchy, and a small sample of item names from each location. It stays on your clipboard until you choose where to paste it. {IS_STANDALONE ? "No account credentials are included." : "Google credentials are never included."}</p>
            <section className="chat-exchange-card" aria-labelledby="chat-response-title"><div><h3 id="chat-response-title">Bring recommendations back</h3><p>Copy the chat’s complete JSON response and paste it below. Tool Findy validates every item and location before creating a review draft.</p></div><textarea rows={7} value={chatResponse} onChange={(event) => setChatResponse(event.target.value)} placeholder={'Paste the response beginning with {"proposedLocations": …'} aria-label="Chat sorting response" /><div className="chat-exchange-actions"><button className="quiet-button" type="button" onClick={() => void pasteSortingChatResponse()}>Paste from clipboard</button><button className="primary-button" type="button" disabled={!chatResponse.trim() || sortBusy} onClick={() => void loadSortingChatResponse()}>{sortBusy ? "Loading…" : sortDraft ? "Replace review draft" : "Load suggestions"}</button></div></section>
            {sortError && <div className="sorting-error" role="alert"><strong>Response needs attention</strong><span>{sortError}</span></div>}
            {!sortDraft && <div className="sorting-awaiting"><strong>No suggestions loaded yet</strong><span>Copy the prompt, ask your chat to answer it, then paste the response above.</span></div>}
            {sortDraft && <>
              {sortDraft.proposedLocations.length > 0 && <section className="proposal-card" aria-labelledby="proposal-title"><div className="section-heading"><div><h3 id="proposal-title">Proposed new locations</h3><p>These are created only if an accepted item uses them. Names and parents are editable.</p></div></div><div className="proposal-grid">{sortDraft.proposedLocations.map((proposal) => <label key={proposal.id}><span>{proposal.reason}</span><input aria-label={`Name for proposed location ${proposal.name}`} value={proposal.name} onChange={(event) => void updateProposedLocation(proposal.id, { name: event.target.value })} /><select aria-label={`Parent for proposed location ${proposal.name}`} value={proposal.parentId} onChange={(event) => void updateProposedLocation(proposal.id, { parentId: event.target.value })}><option value="">Top level</option>{locationOptions.filter(({ location }) => location.id !== sortingLocation.id).map(({ location, path }) => <option key={location.id} value={location.id}>{path}</option>)}</select></label>)}</div></section>}
              <section className="recommendation-list" aria-label="Sorting recommendations">{sortDraft.recommendations.map((recommendation) => {
                const item = data.items.find((candidate) => candidate.id === recommendation.itemId);
                const stale = !item || Boolean(item.deletedAt) || item.locationId !== sortDraft.sourceLocationId || item.version !== recommendation.itemVersion;
                return <article className={`recommendation-row ${recommendation.reviewStatus} ${stale ? "stale" : ""}`} key={recommendation.itemId}>
                  <div className="recommendation-item"><span className={`confidence ${recommendation.confidence}`}>{recommendation.confidence}</span><strong>{item?.name ?? recommendation.itemId}</strong><small>{item ? [item.category, item.tags.join(", ")].filter(Boolean).join(" · ") : "Item no longer available"}</small></div>
                  <div className="recommendation-destination"><label htmlFor={`destination-${recommendation.itemId}`}>Recommended location</label><select id={`destination-${recommendation.itemId}`} disabled={stale} value={`${recommendation.destinationKind}:${recommendation.destinationId}`} onChange={(event) => { const [destinationKind, ...idParts] = event.target.value.split(":"); void updateSortRecommendation(recommendation.itemId, { destinationKind: destinationKind as "existing" | "proposed", destinationId: idParts.join(":"), edited: true, reviewStatus: "pending" }); }}><optgroup label="Existing locations">{locationOptions.filter(({ location }) => location.id !== sortingLocation.id).map(({ location, path }) => <option key={location.id} value={`existing:${location.id}`}>{path}</option>)}</optgroup>{sortDraft.proposedLocations.length > 0 && <optgroup label="Proposed new locations">{sortDraft.proposedLocations.map((proposal) => <option key={proposal.id} value={`proposed:${proposal.id}`}>{proposal.name}</option>)}</optgroup>}</select><p>{stale ? "This item changed after the prompt was copied. Generate and load a fresh response." : recommendation.reason}{recommendation.edited && !stale ? " · Destination edited" : ""}</p></div>
                  <div className="review-actions"><button className={recommendation.reviewStatus === "accepted" ? "accepted-button" : "quiet-button"} type="button" disabled={stale} aria-pressed={recommendation.reviewStatus === "accepted"} onClick={() => void updateSortRecommendation(recommendation.itemId, { reviewStatus: recommendation.reviewStatus === "accepted" ? "pending" : "accepted" })}>{recommendation.reviewStatus === "accepted" ? "✓ Accepted" : "Accept"}</button><button className="skip-button" type="button" disabled={stale} aria-pressed={recommendation.reviewStatus === "skipped"} onClick={() => void updateSortRecommendation(recommendation.itemId, { reviewStatus: recommendation.reviewStatus === "skipped" ? "pending" : "skipped" })}>{recommendation.reviewStatus === "skipped" ? "Skipped" : "Skip"}</button></div>
                </article>;
              })}</section>
              <div className="sorting-apply"><span><strong>{acceptedSortCount}</strong> accepted · {sortDraft.recommendations.filter((row) => row.reviewStatus === "pending").length} pending · {sortDraft.recommendations.filter((row) => row.reviewStatus === "skipped").length} skipped</span><button className="primary-button" type="button" disabled={!acceptedSortCount || sortBusy} onClick={() => void applyAcceptedSorting()}>Apply {acceptedSortCount || ""} accepted</button></div>
            </>}
          </>}
        </section>}

        {view === "locations" && <section className="location-tree-card" aria-labelledby="location-tree-title"><div className="section-heading"><div><h2 id="location-tree-title">Location hierarchy</h2><p>{activeLocations.length} storage location{activeLocations.length === 1 ? "" : "s"}, grouped by what they are inside</p></div><span className="key-hint">Drag onto a location to move it inside · Edit for keyboard access</span></div><div className={`top-level-drop ${dragOverLocationId === "__top__" ? "drop-target" : ""}`} onDragOver={(event) => allowLocationDrop(event, "")} onDrop={(event) => dropLocation(event, "")}><span aria-hidden="true">↖</span><span><strong>Top level</strong><small>Drop here to remove a location from its parent</small></span></div><div className="location-tree" role="tree" aria-label="Storage location hierarchy">{locationTree.map(({ location, depth }) => <div className={`location-tree-row ${draggedLocationId === location.id ? "dragging" : ""} ${dragOverLocationId === location.id ? "drop-target" : ""}`} role="treeitem" aria-level={depth + 1} aria-selected={false} tabIndex={0} key={location.id} draggable onDragStart={(event) => startLocationDrag(event, location.id)} onDragEnd={() => { setDraggedLocationId(""); setDragOverLocationId(""); }} onDragOver={(event) => allowLocationDrop(event, location.id)} onDrop={(event) => dropLocation(event, location.id)} style={{ paddingLeft: `${16 + depth * 28}px` }}><span className="location-drag-handle" aria-hidden="true">⋮⋮</span><span className="location-tree-branch" aria-hidden="true">{depth ? "└" : "⌖"}</span><span className="location-tree-content"><strong>{location.name}</strong><small>{activeItems.filter((item) => item.locationId === location.id).length} items · {location.notes || (depth ? `Inside ${locationPath(location.parentId, activeLocations)}` : "Top-level location")}</small></span><button className="location-edit-button" type="button" onClick={() => openEditLocation(location)} aria-label={`Edit ${location.name}`}>Edit</button></div>)}</div>{!loading && !activeLocations.length && <div className="empty-state"><strong>No locations yet</strong><span>Press N to add your first storage location.</span></div>}</section>}

        {view === "history" && <section className="history-list" aria-label="Change history"><div className="section-heading"><div><h2>Local audit trail</h2><p>{data.history.length} changes retained on this device</p></div><span className="history-note">Append-only</span></div>{data.history.length === 0 ? <div className="empty-state"><strong>No changes yet</strong><span>Your first edit will appear here.</span></div> : data.history.map((event: HistoryEvent) => <article className="history-row" key={event.id}><span className={`history-mark ${event.action}`} aria-hidden="true">{event.action === "create" ? "+" : event.action === "delete" ? "−" : "↺"}</span><div><strong>{event.action === "create" ? "Created" : event.action === "delete" ? (event.entityType === "item" ? "Archived" : "Deleted") : "Changed"} {event.entityType} {event.entityId}</strong><p>{event.field === "*" ? event.newValue : <><b>{event.field}</b>: {event.oldValue || "empty"} → {event.newValue || "empty"}</>}</p></div><time dateTime={event.changedAt}>{new Date(event.changedAt).toLocaleString()}</time><span className={`sync-badge ${!IS_STANDALONE && event.synced ? "done" : ""}`}>{!IS_STANDALONE && event.synced ? "Synced" : "Local"}</span></article>)}</section>}
      </section>

      {dialog === "item" && <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="item-dialog-title"><form ref={dialogFormRef} onSubmit={submitItem}>
        <div className="dialog-header"><div><p className="eyebrow">{itemDraft.id ? itemDraft.id : "New record"}</p><h2 id="item-dialog-title">{itemDraft.id ? "Edit item" : "Add an item"}</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div>
        <div className="form-grid">
          <label className="wide">Item name<input autoFocus required value={itemDraft.name ?? ""} onChange={(event) => setItemDraft({ ...itemDraft, name: event.target.value })} /></label>
          <div className="location-picker"><label>Location<LocationCombobox value={itemDraft.locationId ?? ""} onChange={(locationId) => setItemDraft({ ...itemDraft, locationId })} options={locationOptions} emptyLabel="Unassigned" ariaLabel="Item location" /></label><button className="inline-add-button" type="button" onClick={() => openNewLocation("item")}><span aria-hidden="true">＋</span> Add location</button></div>
          <label className="wide">Tags <span>comma separated</span><input value={(itemDraft.tags ?? []).join(", ")} onChange={(event) => setItemDraft({ ...itemDraft, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></label>
          <div className="more-fields-row">
            <button className="more-fields-button" type="button" aria-expanded={itemDetailsExpanded} aria-controls="item-extra-fields" onClick={() => setItemDetailsExpanded((expanded) => !expanded)}>{itemDetailsExpanded ? "Hide additional fields" : "More fields"}<span aria-hidden="true">{itemDetailsExpanded ? "−" : "+"}</span></button>
          </div>
          <div className="item-extra-fields" id="item-extra-fields" hidden={!itemDetailsExpanded}>
            <label>Category<input list="category-list" value={itemDraft.category ?? ""} onChange={(event) => setItemDraft({ ...itemDraft, category: event.target.value })} /><datalist id="category-list">{categories.map((name) => <option key={name} value={name} />)}</datalist></label>
            <label>Quantity<input type="number" min="0" inputMode="numeric" value={itemDraft.quantity ?? 0} onChange={(event) => setItemDraft({ ...itemDraft, quantity: Number(event.target.value) })} /></label>
            <label>Status<select value={itemDraft.status ?? "Available"} onChange={(event) => setItemDraft({ ...itemDraft, status: event.target.value as ItemStatus })}>{ITEM_STATUSES.filter((status) => status !== "Archived").map((status) => <option key={status}>{status}</option>)}</select></label>
            <label className="wide">Notes<textarea rows={3} value={itemDraft.notes ?? ""} onChange={(event) => setItemDraft({ ...itemDraft, notes: event.target.value })} /></label>
          </div>
        </div>
        <div className="dialog-footer">{itemDraft.id ? <button className="danger-button" type="button" onClick={archiveCurrentItem}>Archive item</button> : <span />}<div><button className="quiet-button" type="button" onClick={() => setDialog(null)}>Cancel <kbd>Esc</kbd></button><button className="primary-button" type="submit">Save item <kbd>{typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘S" : "Ctrl S"}</kbd></button></div></div>
      </form></section></div>}

      {dialog === "batch" && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-dialog-title"><form ref={dialogFormRef} onSubmit={submitBatchItems}>
        <div className="dialog-header"><div><p className="eyebrow">Shared destination</p><h2 id="batch-dialog-title">Batch add items</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div>
        <p className="dialog-copy">Add one item name per line. Every item will use the same location and tags; you can edit individual details afterward.</p>
        <div className="form-grid">
          <label className="wide">Item names <span>one per line</span><textarea autoFocus required rows={7} value={batchNames} onChange={(event) => setBatchNames(event.target.value)} placeholder={"Cordless drill\nTape measure\nSafety glasses"} /></label>
          <div className="location-picker"><label>Location<LocationCombobox value={batchLocationId} onChange={setBatchLocationId} options={locationOptions} emptyLabel="Unassigned" ariaLabel="Batch item location" /></label><button className="inline-add-button" type="button" onClick={() => openNewLocation("batch")}><span aria-hidden="true">＋</span> Add location</button></div>
          <label className="wide">Tags for every item <span>comma separated</span><input value={batchTags} onChange={(event) => setBatchTags(event.target.value)} placeholder="power-tool, workshop" /></label>
          <p className="batch-count" aria-live="polite">{batchItemCount ? `${batchItemCount} item${batchItemCount === 1 ? "" : "s"} ready to add` : "Enter item names to begin"}</p>
        </div>
        <div className="dialog-footer"><span /><div><button className="quiet-button" type="button" onClick={() => setDialog(null)}>Cancel <kbd>Esc</kbd></button><button className="primary-button" type="submit" disabled={!batchItemCount}>Add {batchItemCount || ""} item{batchItemCount === 1 ? "" : "s"}</button></div></div>
      </form></section></div>}

      {dialog === "location" && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="location-dialog-title"><form ref={dialogFormRef} onSubmit={submitLocation}><div className="dialog-header"><div><p className="eyebrow">Storage address</p><h2 id="location-dialog-title">{locationDraft.id ? "Edit location" : "New location"}</h2></div><button className="icon-button" type="button" onClick={closeLocationDialog} aria-label="Close dialog">×</button></div><div className="form-grid"><label className="wide">Name<input autoFocus required value={locationDraft.name ?? ""} onChange={(event) => setLocationDraft({ ...locationDraft, name: event.target.value })} /></label><label className="wide">Inside<select value={locationDraft.parentId ?? ""} onChange={(event) => setLocationDraft({ ...locationDraft, parentId: event.target.value })}><option value="">Top-level location</option>{locationOptions.filter(({ location }) => location.id !== locationDraft.id && !wouldCreateLocationCycle(locationDraft.id ?? "", location.id, activeLocations)).map(({ location, path }) => <option key={location.id} value={location.id}>{path}</option>)}</select></label><label className="wide">Notes<textarea rows={3} value={locationDraft.notes ?? ""} onChange={(event) => setLocationDraft({ ...locationDraft, notes: event.target.value })} /></label></div><div className="dialog-footer">{locationDraft.id && locationDraft.id !== RECYCLE_BIN_LOCATION_ID && locationDraft.name?.trim().toLowerCase() !== "recycle bin" ? <button className="danger-button" type="button" onClick={requestDeleteLocation}>Delete location</button> : <span />}<div><button className="quiet-button" type="button" onClick={closeLocationDialog}>Cancel</button><button className="primary-button" type="submit">Save location</button></div></div></form></section></div>}

      {dialog === "delete-location" && deleteLocationTarget && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-location-title" aria-describedby="delete-location-description"><div className="dialog-header"><div><p className="eyebrow danger-eyebrow">Confirm deletion</p><h2 id="delete-location-title">Delete {deleteLocationTarget.name}?</h2></div><button className="icon-button" type="button" disabled={locationDeletePending} onClick={cancelDeleteLocation} aria-label="Close confirmation">×</button></div><div className="confirmation-body" id="delete-location-description"><p><strong>{data.items.filter((item) => item.locationId === deleteLocationTarget.id).length} item{data.items.filter((item) => item.locationId === deleteLocationTarget.id).length === 1 ? "" : "s"}</strong> will move to the protected <strong>Recycle bin</strong> location.</p>{activeLocations.some((location) => location.parentId === deleteLocationTarget.id) && <p><strong>{activeLocations.filter((location) => location.parentId === deleteLocationTarget.id).length} child location{activeLocations.filter((location) => location.parentId === deleteLocationTarget.id).length === 1 ? "" : "s"}</strong> will move up one level in the hierarchy.</p>}<p className="confirmation-note">{IS_STANDALONE ? "The location will disappear from normal views, but its deletion and all item moves remain in local history and backups." : "The location will disappear from normal views, but its deletion and all item moves remain in local history and sync safely to Google Sheets."}</p></div><div className="dialog-footer"><span /><div><button className="quiet-button" autoFocus type="button" disabled={locationDeletePending} onClick={cancelDeleteLocation}>Cancel</button><button className="destructive-button" type="button" disabled={locationDeletePending} onClick={() => void confirmDeleteLocation()}>{locationDeletePending ? "Deleting…" : "Delete location"}</button></div></div></section></div>}

      {dialog === "restore" && restoreCandidate && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog restore-dialog" role="alertdialog" aria-modal="true" aria-labelledby="restore-title" aria-describedby="restore-description"><div className="dialog-header"><div><p className="eyebrow danger-eyebrow">Local backup restore</p><h2 id="restore-title">Replace local inventory?</h2></div><button className="icon-button" type="button" disabled={restorePending} onClick={cancelRestore} aria-label="Close restore confirmation">×</button></div><div className="restore-summary" id="restore-description"><div className="restore-file"><strong>{restoreCandidate.fileName}</strong><span>Exported {new Date(restoreCandidate.exportedAt).toLocaleString()}</span></div><div className="restore-counts"><span><strong>{restoreCandidate.state.items.filter((item) => !item.deletedAt).length}</strong> active items</span><span><strong>{restoreCandidate.state.locations.filter((location) => !location.deletedAt).length}</strong> locations</span><span><strong>{restoreCandidate.state.history.length}</strong> history entries</span></div><p>{IS_STANDALONE ? "This replaces only the items, locations, and change history in the standalone local database." : "This replaces the items, locations, and change history stored at this local address. Your Google connection settings stay unchanged."}</p><p className="restore-safety-note"><strong>Safety copy included:</strong> Tool Findy will save the current local database as a pre-restore recovery snapshot before replacing it.</p></div><div className="dialog-footer"><span /><div><button className="quiet-button" autoFocus type="button" disabled={restorePending} onClick={cancelRestore}>Cancel</button><button className="destructive-button" type="button" disabled={restorePending} onClick={() => void confirmRestore()}>{restorePending ? "Restoring…" : "Restore backup"}</button></div></div></section></div>}

      {!IS_STANDALONE && dialog === "connect" && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="connect-title"><form ref={dialogFormRef} onSubmit={submitConnection}><div className="dialog-header"><div><p className="eyebrow">Cloud copy</p><h2 id="connect-title">Connect Google Sheets</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div><p className="dialog-copy">Use a Google Cloud Web OAuth client and a Sheet you own. Tool Findy will create its four tabs automatically.</p><div className="form-grid"><label className="wide">OAuth client ID<input name="clientId" required defaultValue={sheetConfig?.clientId ?? DEFAULT_GOOGLE_CLIENT_ID} placeholder="123456789-abc.apps.googleusercontent.com" /></label><label className="wide">Spreadsheet URL or ID<input name="spreadsheetId" required defaultValue={sheetConfig?.spreadsheetId} placeholder="Paste the Google Sheets URL" /></label></div><div className="privacy-note">Authorized JavaScript origin required for this copy: <code>{typeof window !== "undefined" ? window.location.origin : "the local Tool Findy address"}</code><br />Your client ID and Sheet ID stay in this device’s local database. Google access tokens are kept only for the current session.</div><div className="dialog-footer"><span /><div><button className="quiet-button" type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit">Authorize and sync</button></div></div></form></section></div>}

      {!IS_STANDALONE && dialog === "sync-error" && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sync-error-title"><div className="dialog-header"><div><p className="eyebrow danger-eyebrow">Google sync diagnostic</p><h2 id="sync-error-title">Sync needs one correction</h2></div><button className="icon-button" type="button" onClick={() => setDialog(null)} aria-label="Close sync diagnostic">×</button></div><div className="sync-diagnostic"><p className="sync-error-message">{syncError || "Google sync did not complete."}</p><ol><li>In the OAuth Web client, add this exact <strong>Authorized JavaScript origin</strong>: <code>{typeof window !== "undefined" ? window.location.origin : "the local Tool Findy address"}</code></li><li>Make sure the <strong>Google Sheets API</strong> is enabled in the same Cloud project.</li><li>When Google asks, choose an account that can edit the linked Sheet.</li></ol><div className="diagnostic-links"><a href="https://console.cloud.google.com/auth/clients?project=mineral-liberty-334814" target="_blank" rel="noreferrer">Open OAuth client settings</a><a href="https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=mineral-liberty-334814" target="_blank" rel="noreferrer">Open Sheets API settings</a></div></div><div className="dialog-footer"><button className="quiet-button" type="button" onClick={() => setDialog("connect")}>Edit connection</button><div><button className="quiet-button" type="button" onClick={() => setDialog(null)}>Close</button><button className="primary-button" type="button" onClick={() => { setDialog(null); void connectAndSync(); }}>Try again</button></div></div></section></div>}

      {dialog === "help" && <div className="dialog-backdrop" role="presentation"><section className="dialog small-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title"><div className="dialog-header"><div><p className="eyebrow">Keyboard-first</p><h2 id="shortcut-title">Shortcuts</h2></div><button className="icon-button" autoFocus type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button></div><div className="shortcut-list">{[["/ or Ctrl/⌘ K", "Search"], ["N", "New item or location"], ["B", "Batch add items"], ["E", "Edit selected item"], ["↑ ↓ or J K", "Move selection"], ["Enter", "Open selected item"], ["Ctrl/⌘ S", "Save an open form"], ["Escape", "Close a dialog"], ["?", "Show shortcuts"]].map(([key, action]) => <div key={key}><kbd>{key}</kbd><span>{action}</span></div>)}</div></section></div>}

      <button className="help-button" type="button" onClick={() => setDialog("help")} aria-label="Show keyboard shortcuts">?</button><div className="toast" role="status" aria-live="polite" aria-atomic="true">{toast}</div>
    </main>
  );
}
