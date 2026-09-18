export type SearchEntityType = "place" | "board" | "collection";
export type SearchVisibility = "public" | "private" | "shared" | "unlisted";

export interface SearchDocument {
  id: string;
  entity_id: string;
  entity_type: SearchEntityType;
  title: string;
  description?: string;
  searchable_text?: string;
  image_url?: string;
  categories?: string[];
  province?: string;
  country?: string;
  location?: [number, number];
  visibility: SearchVisibility;
  owner_id: string;
  accessible_user_ids?: string[];
  popularity_score: number;
  created_at: number;
  updated_at: number;
}

export interface SearchResult {
  id: string;
  type: SearchEntityType;
  title: string;
  description?: string;
  imageUrl?: string;
  province?: string;
  country?: string;
  categories?: string[];
  score?: number;
}

export interface NormalizedSearchResponse {
  query: string;
  tookMs: number;
  results?: SearchResult[];
  groups?: Record<"places" | "boards" | "collections", SearchResult[]>;
  nextCursor?: string;
}

export interface IndexWebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: "places" | "trip_boards" | "fav_categories";
  schema: "public";
  record?: unknown;
  old_record?: unknown;
}
