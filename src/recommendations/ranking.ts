import type { RecommendationPlace } from "./types.js";

export interface RecommendationSignal {
  placeId: string;
  kind: "like" | "favorite" | "collection";
  createdAt: string;
}

export interface RecommendationProfile {
  categories: Map<string, number>;
  provinces: Map<string, number>;
  countries: Map<string, number>;
  seenPlaceIds: Set<string>;
}

const HALF_LIFE_DAYS = 90;

function decayedWeight(signal: RecommendationSignal, now: number): number {
  const age = Math.max(0, now - new Date(signal.createdAt).getTime()) / 86_400_000;
  const decay = Math.exp(-Math.log(2) * age / HALF_LIFE_DAYS);
  const base = signal.kind === "favorite" ? 2 : signal.kind === "collection" ? 2 : 1;
  return base * decay;
}

function add(map: Map<string, number>, key: string | null | undefined, value: number): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + value);
}

export function buildProfile(signals: RecommendationSignal[], now = Date.now()): RecommendationProfile {
  const profile: RecommendationProfile = {
    categories: new Map(),
    provinces: new Map(),
    countries: new Map(),
    seenPlaceIds: new Set(),
  };
  for (const signal of signals) profile.seenPlaceIds.add(signal.placeId);
  void now;
  return profile;
}

export function buildProfileFromSignals(
  signals: Array<RecommendationSignal & { category?: string | null; province?: string | null; country?: string | null }>,
  now = Date.now(),
): RecommendationProfile {
  const profile: RecommendationProfile = {
    categories: new Map(),
    provinces: new Map(),
    countries: new Map(),
    seenPlaceIds: new Set(),
  };
  for (const signal of signals) {
    const weight = decayedWeight(signal, now);
    profile.seenPlaceIds.add(signal.placeId);
    add(profile.categories, signal.category, weight);
    add(profile.provinces, signal.province, weight);
    add(profile.countries, signal.country, weight * 0.6);
  }
  return profile;
}

function maxValue(map: Map<string, number>): number {
  return Math.max(1, ...map.values());
}

function normalized(map: Map<string, number>, key: string | null | undefined): number {
  return key ? (map.get(key) ?? 0) / maxValue(map) : 0;
}

function freshness(createdAt: string, now: number): number {
  const ageDays = Math.max(0, now - new Date(createdAt).getTime()) / 86_400_000;
  return Math.exp(-ageDays / 180);
}

export function scorePlace(place: RecommendationPlace, profile: RecommendationProfile, now = Date.now()): number {
  const category = normalized(profile.categories, place.category);
  const geography = Math.max(
    normalized(profile.provinces, place.province),
    normalized(profile.countries, place.country) * 0.65,
  );
  const popularity = Math.min(1, Math.log1p(Math.max(0, place.like_count)) / Math.log1p(100));
  return category * 0.5 + geography * 0.2 + popularity * 0.2 + freshness(place.created_at, now) * 0.1;
}

export function rankPlaces(
  places: RecommendationPlace[],
  profile: RecommendationProfile,
  options: { now?: number; seed?: string } = {},
): RecommendationPlace[] {
  const now = options.now ?? Date.now();
  const seed = options.seed ?? "nomadeezee";
  const hash = (value: string): number => {
    let result = 2166136261;
    for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
    return result >>> 0;
  };
  return [...places]
    .filter((place) => !profile.seenPlaceIds.has(place.id))
    .sort((a, b) => {
      const scoreDiff = scorePlace(b, profile, now) - scorePlace(a, profile, now);
      if (Math.abs(scoreDiff) > 0.00001) return scoreDiff;
      return hash(`${seed}:${a.id}`) - hash(`${seed}:${b.id}`);
    });
}
