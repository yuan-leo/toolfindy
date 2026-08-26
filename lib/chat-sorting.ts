import { Item, Location, makeId } from "./inventory";
import { ProposedLocation, SortAnalysisResponse, SortConfidence, SortDraft, buildSortingContext } from "./sorting";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The response is missing ${label}.`);
  return value.trim();
}

export function createSortingPrompt(items: Item[], locations: Location[], sourceLocationId: string) {
  const context = buildSortingContext(items, locations, sourceLocationId);
  return `You are helping me organize a personal inventory of tools and miscellaneous items.

Recommend an existing location when it clearly contains similar items. Propose a new location only when a coherent group has no good existing home. Return exactly one recommendation for every item. Use only existing location IDs from the supplied data or proposed IDs beginning with NEW-. Keep reasons concise.

Return ONLY valid JSON, without markdown fences or commentary, in this exact shape:
{
  "proposedLocations": [
    { "id": "NEW-short-id", "name": "Location name", "parentId": "existing-location-id-or-empty", "reason": "Why this location is useful" }
  ],
  "recommendations": [
    { "itemId": "item-id", "destinationKind": "existing", "destinationId": "location-id", "confidence": "high", "reason": "Why it belongs there" }
  ]
}

destinationKind must be "existing" or "proposed". confidence must be "high", "medium", or "low". A proposed recommendation must use an ID declared in proposedLocations. If no new locations are needed, return an empty proposedLocations array.

INVENTORY DATA:
${JSON.stringify(context, null, 2)}`;
}

function extractJson(value: string) {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Paste the complete JSON response from the chat.");
  try { return JSON.parse(trimmed.slice(start, end + 1)) as unknown; }
  catch { throw new Error("The pasted response is not valid JSON. Ask the chat to return only the requested JSON object."); }
}

export function parseSortRecommendations(responseText: string, items: Item[], locations: Location[], sourceLocationId: string): SortDraft {
  const payload = extractJson(responseText);
  if (!record(payload) || !Array.isArray(payload.proposedLocations) || !Array.isArray(payload.recommendations)) throw new Error("The response must contain proposedLocations and recommendations arrays.");
  const context = buildSortingContext(items, locations, sourceLocationId);
  const itemVersions = new Map(items.map((item) => [item.id, item.version]));
  const expectedItemIds = new Set(context.items.map((item) => item.id));
  const existingLocationIds = new Set(context.locations.map((location) => location.id));
  const proposedIds = new Set<string>();
  const proposedLocations: ProposedLocation[] = payload.proposedLocations.map((value, index) => {
    if (!record(value)) throw new Error(`Proposed location ${index + 1} cannot be read.`);
    const id = text(value.id, `the ID for proposed location ${index + 1}`);
    if (!/^NEW-[A-Za-z0-9_-]+$/.test(id) || proposedIds.has(id)) throw new Error(`Proposed location ID ${id} must be unique and begin with NEW-.`);
    const parentId = typeof value.parentId === "string" ? value.parentId.trim() : "";
    if (parentId && !existingLocationIds.has(parentId)) throw new Error(`Proposed location ${id} uses an unknown parent location.`);
    proposedIds.add(id);
    return { id, name: text(value.name, `the name for proposed location ${index + 1}`), parentId, reason: text(value.reason, `the reason for proposed location ${index + 1}`) };
  });
  const seenItemIds = new Set<string>();
  const recommendations: SortAnalysisResponse["recommendations"] = payload.recommendations.map((value, index) => {
    if (!record(value)) throw new Error(`Recommendation ${index + 1} cannot be read.`);
    const itemId = text(value.itemId, `the item ID for recommendation ${index + 1}`);
    if (!expectedItemIds.has(itemId) || seenItemIds.has(itemId)) throw new Error(`Recommendation item ${itemId} is duplicated or is not in “to be sorted”.`);
    const destinationKind = value.destinationKind === "existing" || value.destinationKind === "proposed" ? value.destinationKind : undefined;
    if (!destinationKind) throw new Error(`Recommendation for ${itemId} has an invalid destinationKind.`);
    const destinationId = text(value.destinationId, `the destination for ${itemId}`);
    if (destinationKind === "existing" ? !existingLocationIds.has(destinationId) : !proposedIds.has(destinationId)) throw new Error(`Recommendation for ${itemId} uses an unknown destination.`);
    const confidence = value.confidence as SortConfidence;
    if (!(["high", "medium", "low"] as const).includes(confidence)) throw new Error(`Recommendation for ${itemId} has an invalid confidence.`);
    seenItemIds.add(itemId);
    return { itemId, destinationKind, destinationId, confidence, reason: text(value.reason, `the reason for ${itemId}`) };
  });
  if (seenItemIds.size !== expectedItemIds.size) throw new Error(`The response contains ${seenItemIds.size} of ${expectedItemIds.size} required item recommendations.`);
  return {
    id: makeId("SORT"),
    createdAt: new Date().toISOString(),
    sourceLocationId,
    model: "pasted-chat-response",
    proposedLocations,
    recommendations: recommendations.map((recommendation) => ({ ...recommendation, itemVersion: itemVersions.get(recommendation.itemId) ?? 0, reviewStatus: "pending", edited: false })),
  };
}

