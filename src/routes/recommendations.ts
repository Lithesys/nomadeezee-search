import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decodeCursor, decodeRecommendationCursor, encodeCursor, encodeRecommendationCursor } from "../search/cursor.js";
import { requestSupabase } from "../search/supabase.js";
import type { Env } from "../config/env.js";
import type { AuthIdentity } from "../auth/supabase-auth.js";
import { buildProfileFromSignals, rankPlaces, type RecommendationSignal } from "../recommendations/ranking.js";
import { buildExplorationFeed, profileHasSignals } from "../recommendations/exploration.js";
import type { RecommendationCandidate, RecommendationPlace, RecommendationResponse } from "../recommendations/types.js";

const querySchema = z.object({
  categories: z.string().optional().transform((value) => value?.split(",").map((part) => part.trim()).filter(Boolean)),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  cursor: z.string().max(16_000).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  session_id: z.string().uuid().optional(),
}).strict().refine((query) => (query.lat === undefined) === (query.lng === undefined), {
  message: "Latitude and longitude must be supplied together",
});

const impressionSchema = z.object({
  sessionId: z.string().uuid().optional(),
  requestId: z.string().uuid(),
  impressions: z.array(z.object({
    placeId: z.string().uuid(),
    position: z.number().int().min(1).max(1000),
    source: z.enum(["collaborative", "content", "nearby", "trending", "exploration", "search", "similar"]),
    score: z.number().min(0).max(1).optional(),
  }).strict()).min(1).max(50),
}).strict();

const eventSchema = z.object({
  sessionId: z.string().uuid().optional(),
  events: z.array(z.object({
    clientEventId: z.string().uuid().optional(),
    placeId: z.string().uuid(),
    requestId: z.string().uuid().optional(),
    position: z.number().int().min(1).max(1000).optional(),
    source: z.enum(["collaborative", "content", "nearby", "trending", "exploration", "search", "similar"]),
    eventType: z.enum(["detail_open", "long_detail_view", "like", "save", "share", "hide"]),
  }).strict()).min(1).max(50),
}).strict();

const similarParams = z.object({ id: z.string().uuid() }).strict();

type Row = Record<string, unknown>;

const anonymousSessionHistory = new Map<string, { placeIds: Set<string>; expiresAt: number }>();

function asPlace(row: Row): RecommendationPlace | null {
  if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.user_id !== "string") return null;
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    id: row.id,
    type: "place",
    title: row.title,
    description: typeof row.description === "string" ? row.description : undefined,
    province: typeof row.province === "string" ? row.province : undefined,
    country: typeof row.country === "string" ? row.country : undefined,
    categories: typeof row.category === "string" ? [row.category] : undefined,
    user_id: row.user_id,
    category: typeof row.category === "string" ? row.category : "other",
    latitude,
    longitude,
    address: typeof row.address === "string" ? row.address : null,
    is_public: row.is_public === true,
    is_premium_only: row.is_premium_only === true,
    created_at: typeof row.created_at === "string" ? row.created_at : new Date(0).toISOString(),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
    like_count: Number(row.like_count) || 0,
    comment_count: Number(row.comment_count) || 0,
  };
}

function asCandidate(row: Row): RecommendationCandidate | null {
  const place = asPlace(row);
  if (!place) return null;
  return {
    ...place,
    impression_count: Number(row.impression_count) || 0,
    last_impression_at: typeof row.last_impression_at === "string" ? row.last_impression_at : null,
    quality_score: Number(row.quality_score) || 0,
    popularity_score: Number(row.popularity_score) || 0,
    distance_km: row.distance_km == null ? null : Number(row.distance_km),
    has_image: row.has_image === true,
    metadata_completeness: Number(row.metadata_completeness) || 0,
    is_hidden: row.is_hidden === true,
  };
}

function publicPlace(candidate: RecommendationCandidate): RecommendationPlace {
  return {
    id: candidate.id,
    type: "place",
    title: candidate.title,
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.province ? { province: candidate.province } : {}),
    ...(candidate.country ? { country: candidate.country } : {}),
    ...(candidate.categories?.length ? { categories: candidate.categories } : {}),
    user_id: candidate.user_id,
    category: candidate.category,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    address: candidate.address,
    is_public: candidate.is_public,
    is_premium_only: candidate.is_premium_only,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
    like_count: candidate.like_count,
    comment_count: candidate.comment_count,
  };
}

function validCoordinates(lat: number | undefined, lng: number | undefined): lat is number {
  return lat !== undefined && lng !== undefined;
}

async function queryCandidates(
  client: ReturnType<typeof requestSupabase>,
  options: { lat?: number; lng?: number; radiusKm?: number; categories?: string[]; preferredCategories?: string[]; provinces?: string[]; countries?: string[]; limit: number; excluded: string[]; unseen: boolean },
): Promise<RecommendationCandidate[]> {
  const { data, error } = await client.rpc("get_recommendation_candidates", {
    p_latitude: options.lat ?? null,
    p_longitude: options.lng ?? null,
    p_radius_km: options.radiusKm ?? null,
    p_categories: options.categories?.length ? options.categories : null,
    p_preferred_categories: options.preferredCategories?.length ? options.preferredCategories : null,
    p_provinces: options.provinces?.length ? options.provinces : null,
    p_countries: options.countries?.length ? options.countries : null,
    p_limit: options.limit,
    p_excluded_place_ids: options.excluded,
    p_require_unseen: options.unseen,
  });
  if (error) throw error;
  return ((data ?? []) as Row[]).map(asCandidate).filter((candidate): candidate is RecommendationCandidate => candidate !== null);
}

async function buildV2Feed(
  client: ReturnType<typeof requestSupabase>,
  identity: AuthIdentity | undefined,
  env: Env,
  parsed: z.infer<typeof querySchema>,
  request: FastifyRequest,
): Promise<RecommendationResponse> {
  const userId = identity?.userId;
  let signals: RecommendationSignal[] = [];
  let details = new Map<string, Row>();
  if (userId) {
    signals = await readSignals(client, userId);
    const signalIds = [...new Set(signals.map((signal) => signal.placeId))];
    const signalPlaces = signalIds.length
      ? await client.from("places").select("id,category,province,country").in("id", signalIds)
      : { data: [], error: null };
    if (signalPlaces.error) throw signalPlaces.error;
    details = new Map(((signalPlaces.data ?? []) as Row[]).map((row) => [String(row.id), row]));
  }
  const profile = buildProfileFromSignals(signals.map((signal) => ({ ...signal, ...(details.get(signal.placeId) ?? {}) })));
  const fingerprint = JSON.stringify({ userId: userId ?? parsed.session_id ?? "anonymous", categories: parsed.categories?.slice().sort() ?? [], lat: parsed.lat ?? null, lng: parsed.lng ?? null, limit: parsed.limit });
  let cursor;
  try { cursor = decodeRecommendationCursor(parsed.cursor, fingerprint, env.SEARCH_CURSOR_SECRET); }
  catch { throw Object.assign(new Error("Invalid or expired cursor"), { statusCode: 400, code: "INVALID_CURSOR" }); }
  const seed = cursor.seed || randomUUID();
  const excluded = new Set(cursor.excludedPlaceIds);
  for (const id of profile.seenPlaceIds) excluded.add(id);
  const sessionId = parsed.session_id;
  if (!userId && sessionId) {
    const history = anonymousSessionHistory.get(sessionId);
    if (history && history.expiresAt > Date.now()) for (const id of history.placeIds) excluded.add(id);
    else anonymousSessionHistory.delete(sessionId);
  }

  const candidateLimit = Math.min(150, Math.max(100, parsed.limit * 5));
  const radii = validCoordinates(parsed.lat, parsed.lng) ? [3, 5, 10, 20, 30] : [undefined];
  const candidates = new Map<string, RecommendationCandidate>();
  for (const radiusKm of radii) {
    const [exploitation, exploration] = await Promise.all([
      queryCandidates(client, { lat: parsed.lat, lng: parsed.lng, radiusKm, categories: parsed.categories, preferredCategories: [...profile.categories.keys()], provinces: [...profile.provinces.keys()], countries: [...profile.countries.keys()], limit: candidateLimit, excluded: [...excluded], unseen: false }),
      queryCandidates(client, { lat: parsed.lat, lng: parsed.lng, radiusKm, categories: parsed.categories, preferredCategories: [...profile.categories.keys()], provinces: [...profile.provinces.keys()], countries: [...profile.countries.keys()], limit: candidateLimit, excluded: [...excluded], unseen: true }),
    ]);
    for (const candidate of [...exploitation, ...exploration]) candidates.set(candidate.id, candidate);
    if (candidates.size >= Math.min(200, candidateLimit * 2)) break;
  }

  const explorationRate = env.RECOMMENDATION_EXPLORATION_ENABLED ? env.RECOMMENDATION_EXPLORATION_RATE : 0;
  const items = buildExplorationFeed([...candidates.values()], profile, {
    rate: explorationRate,
    temperature: env.RECOMMENDATION_EXPLORATION_TEMPERATURE,
    recentSeenHours: env.RECOMMENDATION_RECENT_SEEN_HOURS,
    seenPenaltyDays: env.RECOMMENDATION_SEEN_PENALTY_DAYS,
    feedSize: parsed.limit,
  }, seed);
  const requestId = randomUUID();
  const returnedIds = items.map((item) => item.place.id);
  const excludedPlaceIds = [...new Set([...cursor.excludedPlaceIds, ...returnedIds])].slice(-500);
  const nextCursor = items.length === parsed.limit
    ? encodeRecommendationCursor({ seed, excludedPlaceIds }, fingerprint, env.SEARCH_CURSOR_SECRET)
    : undefined;
  const publicItems = items.map((item) => ({ ...item, place: publicPlace(item.place as RecommendationCandidate) }));
  request.log.info({ requestId, userId, sessionId, candidateCount: candidates.size, explorationCandidateCount: [...candidates.values()].filter((item) => item.impression_count === 0).length, finalFeedSize: items.length, explorationCount: items.filter((item) => item.recommendation.isExploration).length }, "recommendation feed generated");
  return {
    requestId,
    items: publicItems,
    places: publicItems.map((item) => item.place),
    ...(nextCursor ? { nextCursor } : {}),
    personalized: profileHasSignals(profile),
    algorithmVersion: env.RECOMMENDATION_EXPLORATION_ENABLED ? "exploration-v2" : "ranking-v2",
  };
}

async function readSignals(client: ReturnType<typeof requestSupabase>, userId: string): Promise<RecommendationSignal[]> {
  const [likes, favorites, collections] = await Promise.all([
    client.from("likes").select("place_id,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(100),
    client.from("favorites").select("place_id,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(100),
    client.from("fav_category_places").select("place_id,added_at,added_by").eq("added_by", userId).order("added_at", { ascending: false }).limit(100),
  ]);
  for (const result of [likes, favorites, collections]) if (result.error) throw result.error;
  return [
    ...((likes.data ?? []) as Row[]).flatMap((row) => typeof row.place_id === "string" ? [{ placeId: row.place_id, kind: "like" as const, createdAt: String(row.created_at) }] : []),
    ...((favorites.data ?? []) as Row[]).flatMap((row) => typeof row.place_id === "string" ? [{ placeId: row.place_id, kind: "favorite" as const, createdAt: String(row.created_at) }] : []),
    ...((collections.data ?? []) as Row[]).flatMap((row) => typeof row.place_id === "string" ? [{ placeId: row.place_id, kind: "collection" as const, createdAt: String(row.added_at) }] : []),
  ];
}

async function readableCandidates(client: ReturnType<typeof requestSupabase>, categories?: string[]): Promise<RecommendationPlace[]> {
  let query = client.from("places_with_counts").select("*").eq("is_public", true).order("created_at", { ascending: false }).limit(300);
  if (categories?.length) query = query.in("category", categories);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Row[]).map(asPlace).filter((place): place is RecommendationPlace => place !== null);
}

function fingerprint(userId: string, categories: string[] | undefined): string {
  return JSON.stringify({ userId, categories: categories?.slice().sort() ?? [] });
}

export async function registerRecommendationRoutes(app: FastifyInstance, env: Env): Promise<void> {
  const recommendationFeed = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.identity as AuthIdentity | undefined;
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_QUERY", issues: parsed.error.issues });
    if (env.RECOMMENDATION_EXPLORATION_ENABLED) {
      try {
        return await buildV2Feed(requestSupabase(env, identity?.token), identity, env, parsed.data, request);
      } catch (error) {
        const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "RECOMMENDATION_FEED_FAILED";
        request.log.error({ error: error instanceof Error ? error.message : "unknown", statusCode }, "recommendation feed failed");
        return reply.code(statusCode).send({ code });
      }
    }
    if (!identity) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const categories = parsed.data.categories;
    const client = requestSupabase(env, identity.token);
    const [signals, candidates] = await Promise.all([readSignals(client, identity.userId), readableCandidates(client, categories)]);
    const placeIds = [...new Set(signals.map((signal) => signal.placeId))];
    const signalPlaces = placeIds.length ? await client.from("places").select("id,category,province,country").in("id", placeIds) : { data: [], error: null };
    if (signalPlaces.error) throw signalPlaces.error;
    const details = new Map(((signalPlaces.data ?? []) as Row[]).map((row) => [row.id as string, row]));
    const profile = buildProfileFromSignals(signals.map((signal) => ({ ...signal, ...(details.get(signal.placeId) ?? {}) })));
    const fp = fingerprint(identity.userId, categories);
    let offset = 0;
    try { offset = decodeCursor(parsed.data.cursor, fp, env.SEARCH_CURSOR_SECRET); } catch { return reply.code(400).send({ code: "INVALID_CURSOR" }); }
    const ranked = rankPlaces(candidates, profile, { seed: identity.userId });
    const places = ranked.slice(offset, offset + parsed.data.limit);
    const nextCursor = offset + places.length < ranked.length ? encodeCursor(offset + places.length, fp, env.SEARCH_CURSOR_SECRET) : undefined;
    return { places, personalized: signals.length > 0, algorithmVersion: "actions-v1", ...(nextCursor ? { nextCursor } : {}) } satisfies RecommendationResponse;
  };

  app.get("/v1/recommendations", recommendationFeed);
  app.get("/v1/recommendations/feed", async (request, reply) => {
    if (!env.RECOMMENDATION_EXPLORATION_ENABLED) return reply.code(404).send({ code: "RECOMMENDATIONS_V2_DISABLED" });
    return recommendationFeed(request, reply);
  });

  app.post("/v1/recommendations/impressions", async (request, reply) => {
    const parsed = impressionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_IMPRESSIONS" });
    if (!request.identity && !parsed.data.sessionId) return reply.code(400).send({ code: "SESSION_REQUIRED" });
    const client = requestSupabase(env, request.identity?.token);
    const { data, error } = await client.rpc("record_recommendation_impressions", {
      p_request_id: parsed.data.requestId,
      p_session_id: parsed.data.sessionId ?? null,
      p_impressions: parsed.data.impressions.map((item) => ({ place_id: item.placeId, position: item.position, source: item.source, score: item.score ?? null })),
    });
    if (error) {
      request.log.warn({ error: error.message }, "recommendation impressions rejected");
      return reply.code(400).send({ code: "IMPRESSIONS_REJECTED" });
    }
    if (!request.identity && parsed.data.sessionId) {
      const now = Date.now();
      for (const [key, value] of anonymousSessionHistory) if (value.expiresAt <= now) anonymousSessionHistory.delete(key);
      if (anonymousSessionHistory.size > 5000) anonymousSessionHistory.delete(anonymousSessionHistory.keys().next().value as string);
      const prior = anonymousSessionHistory.get(parsed.data.sessionId);
      const placeIds = prior?.placeIds ?? new Set<string>();
      for (const item of parsed.data.impressions) placeIds.add(item.placeId);
      anonymousSessionHistory.set(parsed.data.sessionId, { placeIds, expiresAt: now + 30 * 60_000 });
    }
    return { accepted: Number(data) || 0 };
  });

  app.post("/v1/recommendations/events", async (request, reply) => {
    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_EVENTS" });
    if (!request.identity && !parsed.data.sessionId) return reply.code(400).send({ code: "SESSION_REQUIRED" });
    const client = requestSupabase(env, request.identity?.token);
    const { data, error } = await client.rpc("record_recommendation_events", {
      p_session_id: parsed.data.sessionId ?? null,
      p_events: parsed.data.events.map((item) => ({
        client_event_id: item.clientEventId ?? randomUUID(),
        place_id: item.placeId,
        request_id: item.requestId ?? null,
        position: item.position ?? null,
        source: item.source,
        event_type: item.eventType,
      })),
    });
    if (error) {
      request.log.warn({ error: error.message }, "recommendation events rejected");
      return reply.code(400).send({ code: "EVENTS_REJECTED" });
    }
    return { accepted: Number(data) || 0 };
  });

  app.get("/v1/places/:id/similar", async (request, reply) => {
    const params = similarParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "INVALID_PLACE_ID" });
    const identity = request.identity;
    const client = requestSupabase(env, identity?.token);
    const { data: source, error: sourceError } = await client.from("places_with_counts").select("*").eq("id", params.data.id).eq("is_public", true).maybeSingle();
    if (sourceError) throw sourceError;
    const sourcePlace = asPlace((source ?? {}) as Row);
    if (!sourcePlace) return reply.code(404).send({ code: "PLACE_NOT_FOUND" });
    const candidates = await readableCandidates(client, [sourcePlace.category]);
    const profile = buildProfileFromSignals([{ placeId: sourcePlace.id, kind: "favorite", createdAt: new Date().toISOString(), category: sourcePlace.category, province: sourcePlace.province, country: sourcePlace.country }]);
    const places = rankPlaces(candidates, profile, { seed: sourcePlace.id }).slice(0, 12);
    return { places, personalized: false, algorithmVersion: "similar-v1" } satisfies RecommendationResponse;
  });
}
