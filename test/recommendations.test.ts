import { describe, expect, it } from "vitest";
import { buildProfileFromSignals, rankPlaces, scorePlace } from "../src/recommendations/ranking.js";
import type { RecommendationPlace } from "../src/recommendations/types.js";

const place = (id: string, category: string, province: string, likes = 0): RecommendationPlace => ({
  id, type: "place", title: id, user_id: "owner", category, province, country: "VN", latitude: 1, longitude: 2,
  address: null, is_public: true, is_premium_only: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), like_count: likes, comment_count: 0,
});

describe("recommendation ranking", () => {
  it("favors a user's saved category and excludes consumed places", () => {
    const profile = buildProfileFromSignals([{ placeId: "seen", kind: "favorite", createdAt: new Date().toISOString(), category: "cafe", province: "Da Nang", country: "VN" }]);
    const ranked = rankPlaces([place("seen", "cafe", "Da Nang"), place("match", "cafe", "Da Nang"), place("other", "beach", "Hanoi")], profile, { seed: "u" });
    expect(ranked.map((item) => item.id)).toEqual(["match", "other"]);
    expect(scorePlace(ranked[0]!, profile)).toBeGreaterThan(scorePlace(ranked[1]!, profile));
  });
});
