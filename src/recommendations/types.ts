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
  requestId?: string;
  items?: RecommendationFeedItem[];
  nextCursor?: string;
  personalized: boolean;
  algorithmVersion: string;
}

export type RecommendationSource = "collaborative" | "content" | "nearby" | "trending" | "exploration";

export interface RecommendationCandidate extends RecommendationPlace {
  impression_count: number;
  last_impression_at: string | null;
  quality_score: number;
  popularity_score: number;
  distance_km: number | null;
  has_image: boolean;
  metadata_completeness: number;
  is_hidden: boolean;
}

export interface RecommendationFeedItem {
  place: RecommendationPlace;
  recommendation: {
    source: RecommendationSource;
    score: number;
    isExploration: boolean;
  };
}

export interface RecommendationQuery {
  categories?: string[];
  limit: number;
  cursor?: string;
}
