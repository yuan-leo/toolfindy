import { Item, Location } from "./inventory";

export type SortReviewStatus = "pending" | "accepted" | "skipped";
export type SortConfidence = "high" | "medium" | "low";

export interface ProposedLocation {
  id: string;
  name: string;
  parentId: string;
  reason: string;
}

export interface SortRecommendation {
  itemId: string;
  itemVersion: number;
  destinationKind: "existing" | "proposed";
  destinationId: string;
  confidence: SortConfidence;
  reason: string;
  reviewStatus: SortReviewStatus;
  edited: boolean;
}

export interface SortDraft {
  id: string;
  createdAt: string;
  sourceLocationId: string;
  model: string;
  proposedLocations: ProposedLocation[];
  recommendations: SortRecommendation[];
}

export interface SortAnalysisResponse {
  model: string;
  proposedLocations: ProposedLocation[];
  recommendations: Array<Omit<SortRecommendation, "itemVersion" | "reviewStatus" | "edited">>;
}

export function buildSortingContext(items: Item[], locations: Location[], sourceLocationId: string) {
  const activeLocations = locations.filter((location) => !location.deletedAt);
  return {
    sourceLocationId,
    items: items.filter((item) => !item.deletedAt && item.locationId === sourceLocationId).map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      tags: item.tags,
      notes: item.notes,
    })),
    locations: activeLocations.filter((location) => location.id !== sourceLocationId).map((location) => ({
      id: location.id,
      name: location.name,
      parentId: location.parentId,
      notes: location.notes,
      sampleItems: items.filter((item) => !item.deletedAt && item.locationId === location.id).slice(0, 8).map((item) => item.name),
    })),
  };
}

