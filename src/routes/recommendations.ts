import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decodeCursor, encodeCursor } from "../search/cursor.js";
import { requestSupabase } from "../search/supabase.js";
import type { Env } from "../config/env.js";
import type { AuthIdentity } from "../auth/supabase-auth.js";
import { buildProfileFromSignals, rankPlaces, type RecommendationSignal } from "../recommendations/ranking.js";
import type { RecommendationPlace, RecommendationResponse } from "../recommendations/types.js";

const querySchema = z.object({
  categories: z.string().optional().transform((value) => value?.split(",").map((part) => part.trim()).filter(Boolean)),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  cursor: z.string().max(2000).optional(),
}).strict();

const similarParams = z.object({ id: z.string().uuid() }).strict();

type Row = Record<string, unknown>;

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
  app.get("/v1/recommendations", async (request, reply) => {
    const identity = request.identity as AuthIdentity | undefined;
    if (!identity) return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_QUERY", issues: parsed.error.issues });
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
