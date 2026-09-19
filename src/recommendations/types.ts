import type { SearchResult } from "../types/search.js";

export interface RecommendationPlace extends SearchResult {
  user_id: string;
  category: string;
  latitude: number;
  longitude: number;
  address: string | null;
  is_public: boolean;
  is_premium_only: boolean;
  created_at: string;
  updated_at: string;
  like_count: number;
  comment_count: number;
}

export interface RecommendationResponse {
  places: RecommendationPlace[];
  nextCursor?: string;
  personalized: boolean;
  algorithmVersion: string;
}

export interface RecommendationQuery {
  categories?: string[];
  limit: number;
  cursor?: string;
}
