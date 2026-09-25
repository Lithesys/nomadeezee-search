import type { RecommendationProfile } from "./ranking.js";
import { scorePlace } from "./ranking.js";
import type { RecommendationCandidate, RecommendationFeedItem, RecommendationSource } from "./types.js";

export interface ExplorationConfig {
  rate: number;
  temperature: number;
  recentSeenHours: number;
  seenPenaltyDays: number;
  feedSize: number;
}

interface ScoredCandidate {
  candidate: RecommendationCandidate;
  score: number;
  explorationScore: number;
  source: RecommendationSource;
  unseen: boolean;
}

function normalized(values: Map<string, number>, value: string | null | undefined): number {
  if (!value) return 0;
  const max = Math.max(1, ...values.values());
  return (values.get(value) ?? 0) / max;
}

function freshness(createdAt: string, now: number): number {
  const ageDays = Math.max(0, now - new Date(createdAt).getTime()) / 86_400_000;
  return Math.exp(-ageDays / 180);
}

function seenMultiplier(lastSeenAt: string | null, now: number, maxDays: number): number {
  if (!lastSeenAt) return 1;
  const days = Math.max(0, now - new Date(lastSeenAt).getTime()) / 86_400_000;
  if (days < 0.25) return 0;
  if (days < 1) return 0.15;
  if (days < 3) return 0.35;
  if (days < 7) return 0.6;
  if (days < 14) return 0.8;
  if (days < maxDays) return 0.95;
  return 1;
}

function scoreCandidate(candidate: RecommendationCandidate, profile: RecommendationProfile, now: number, recentSeenHours: number, seenPenaltyDays: number): ScoredCandidate {
  const category = normalized(profile.categories, candidate.category);
  const province = normalized(profile.provinces, candidate.province);
  const country = normalized(profile.countries, candidate.country) * 0.65;
  const profileGeo = Math.max(province, country);
  const distance = candidate.distance_km === null ? 0 : Math.max(0, 1 - candidate.distance_km / 30);
  const hasProfile = profile.categories.size + profile.provinces.size + profile.countries.size > 0;
  const content = Math.max(category, profileGeo);
  const geographic = candidate.distance_km === null ? profileGeo : Math.max(profileGeo, distance);
  const popularity = Math.min(1, Math.max(0, candidate.popularity_score));
  const quality = Math.min(1, Math.max(0, candidate.quality_score));
  const fresh = freshness(candidate.created_at, now);
  const personalized = hasProfile ? Math.min(1, category * 0.65 + profileGeo * 0.35) : 0;
  const base = hasProfile
    ? 0.35 * personalized + 0.20 * content + 0.15 * distance + 0.15 * quality + 0.10 * fresh + 0.05 * popularity
    : 0.35 * distance + 0.25 * quality + 0.20 * popularity + 0.20 * fresh;
  const unseen = candidate.impression_count === 0 && !candidate.last_impression_at;
  const hoursSinceSeen = candidate.last_impression_at ? (now - new Date(candidate.last_impression_at).getTime()) / 3_600_000 : Number.POSITIVE_INFINITY;
  const seenFactor = hoursSinceSeen < recentSeenHours ? 0 : seenMultiplier(candidate.last_impression_at, now, seenPenaltyDays);
  const score = base * seenFactor;
  const explorationScore = 0.30 * content + 0.25 * geographic + 0.20 * quality + 0.15 * fresh + 0.10 * popularity;
  const source: RecommendationSource = hasProfile && personalized >= 0.2
    ? "content"
    : candidate.distance_km !== null && candidate.distance_km <= 30
      ? "nearby"
      : popularity >= 0.35
        ? "trending"
        : "content";
  return { candidate, score, explorationScore, source, unseen };
}

function hashSeed(seed: string): number {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0 || 1;
}

function randomFor(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function weightedSample(candidates: ScoredCandidate[], count: number, temperature: number, seed: string): ScoredCandidate[] {
  const remaining = [...candidates];
  const random = randomFor(seed);
  const selected: ScoredCandidate[] = [];
  while (remaining.length && selected.length < count) {
    const weights = remaining.map((item) => Math.exp(item.explorationScore / temperature));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let target = random() * total;
    let index = weights.findIndex((weight) => (target -= weight) <= 0);
    if (index < 0) index = remaining.length - 1;
    selected.push(remaining[index]!);
    remaining.splice(index, 1);
  }
  return selected;
}

function mixThroughFeed(exploitation: ScoredCandidate[], exploration: ScoredCandidate[], size: number): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  let normalIndex = 0;
  let exploreIndex = 0;
  const total = Math.min(size, exploitation.length + exploration.length);
  const explorationPositions = new Set(exploration.map((_, index) => Math.max(1, Math.round((index + 1) * (total + 1) / (exploration.length + 1)))));
  for (let position = 1; position <= total; position += 1) {
    if (explorationPositions.has(position) && exploreIndex < exploration.length) out.push(exploration[exploreIndex++]!);
    else if (normalIndex < exploitation.length) out.push(exploitation[normalIndex++]!);
    else if (exploreIndex < exploration.length) out.push(exploration[exploreIndex++]!);
  }
  while (normalIndex < exploitation.length && out.length < size) out.push(exploitation[normalIndex++]!);
  while (exploreIndex < exploration.length && out.length < size) out.push(exploration[exploreIndex++]!);
  return out;
}

function diversify(items: ScoredCandidate[], maxSameCategory = 2): ScoredCandidate[] {
  const remaining = [...items];
  const result: ScoredCandidate[] = [];
  while (remaining.length) {
    const tail = result.slice(-maxSameCategory).map((item) => item.candidate.category);
    let nextIndex = remaining.findIndex((item) => item.candidate.category == null || !tail.every((category) => category === item.candidate.category));
    if (nextIndex < 0) nextIndex = 0;
    result.push(remaining.splice(nextIndex, 1)[0]!);
  }
  return result;
}

export function buildExplorationFeed(
  candidates: RecommendationCandidate[],
  profile: RecommendationProfile,
  config: ExplorationConfig,
  seed: string,
  now = Date.now(),
): RecommendationFeedItem[] {
  const scored = candidates
    .filter((candidate) => !candidate.is_hidden)
    .map((candidate) => scoreCandidate(candidate, profile, now, config.recentSeenHours, config.seenPenaltyDays));
  const recentlySeen = scored.filter((item) => item.score === 0 && item.candidate.last_impression_at);
  let eligible = scored.filter((item) => item.score > 0);
  if (eligible.length < config.feedSize) eligible = [...eligible, ...recentlySeen];

  const explorationCount = config.rate <= 0
    ? 0
    : Math.min(config.feedSize, Math.max(1, Math.round(config.feedSize * config.rate)));
  const qualityEligible = eligible.filter((item) =>
    (item.unseen || (item.candidate.last_impression_at !== null && now - new Date(item.candidate.last_impression_at).getTime() >= config.seenPenaltyDays * 86_400_000))
    && item.candidate.has_image
    && item.candidate.metadata_completeness >= 0.5
    && item.explorationScore >= 0.2,
  );
  const exploration = weightedSample(qualityEligible, explorationCount, config.temperature, `${seed}:exploration`);
  const explorationIds = new Set(exploration.map((item) => item.candidate.id));
  const exploitation = eligible
    .filter((item) => !explorationIds.has(item.candidate.id))
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, config.feedSize - exploration.length);
  const mixed = diversify(mixThroughFeed(exploitation, exploration, config.feedSize));
  return mixed.slice(0, config.feedSize).map((item) => {
    const isExploration = explorationIds.has(item.candidate.id);
    return {
      place: item.candidate,
      recommendation: {
        source: isExploration ? "exploration" : item.source,
        score: Number((isExploration ? item.explorationScore : item.score).toFixed(4)),
        isExploration,
      },
    };
  });
}

export function profileHasSignals(profile: RecommendationProfile): boolean {
  return profile.categories.size + profile.provinces.size + profile.countries.size > 0;
}

export function baseScoreForCandidate(candidate: RecommendationCandidate, profile: RecommendationProfile, now = Date.now()): number {
  return scoreCandidate(candidate, profile, now, 0, 30).score;
}
