import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { buildFilter } from "../search/filters.js";
import { decodeCursor, encodeCursor } from "../search/cursor.js";
import { searchQuerySchema } from "../search/schema.js";
import { FULL_SEARCH_PARAMS, SUGGEST_PARAMS } from "../search/ranking.js";
import { readableSummaries, requestSupabase } from "../search/supabase.js";
import type { Env } from "../config/env.js";
import type { SearchDocument, SearchEntityType, SearchResult } from "../types/search.js";

function resultFromDocument(document: SearchDocument, score?: number): SearchResult { return { id: document.entity_id, type: document.entity_type, title: document.title, ...(document.description ? { description: document.description } : {}), ...(document.province ? { province: document.province } : {}), ...(document.country ? { country: document.country } : {}), ...(document.categories?.length ? { categories: document.categories } : {}), ...(score === undefined ? {} : { score }) }; }
function fingerprint(input: unknown): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }

async function queryRoute(app: FastifyInstance, env: Env, suggestion: boolean): Promise<void> {
  app.get(suggestion ? "/v1/suggest" : "/v1/search", async (request, reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_QUERY", issues: parsed.error.issues });
    const query = parsed.data;
    if (suggestion && query.q.length < 2) return { query: query.q, tookMs: 0, groups: { places: [], boards: [], collections: [] } };
    const identity = request.identity;
    const types = query.types as SearchEntityType[] | undefined;
    const geo = query.lat === undefined ? undefined : { lat: query.lat, lng: query.lng!, radiusKm: query.radiusKm! };
    const filterBy = buildFilter({ userId: identity?.userId, types, categories: query.categories, province: query.province, country: query.country, geo });
    const fp = fingerprint({ q: query.q, types, categories: query.categories, province: query.province, country: query.country, geo, mode: query.mode });
    let offset: number;
    try { offset = decodeCursor(query.cursor, fp, env.SEARCH_CURSOR_SECRET); } catch { return reply.code(400).send({ code: "INVALID_CURSOR" }); }
    const started = Date.now();
    const response = await app.typesense.collections(env.SEARCH_INDEX_NAME).documents().search({ q: query.q || "*", query_by: suggestion ? SUGGEST_PARAMS.query_by : FULL_SEARCH_PARAMS.query_by, query_by_weights: suggestion ? SUGGEST_PARAMS.query_by_weights : FULL_SEARCH_PARAMS.query_by_weights, num_typos: suggestion ? SUGGEST_PARAMS.num_typos : FULL_SEARCH_PARAMS.num_typos, prefix: suggestion ? SUGGEST_PARAMS.prefix : FULL_SEARCH_PARAMS.prefix, typo_tokens_threshold: 1, drop_tokens_threshold: 0, filter_by: filterBy, sort_by: FULL_SEARCH_PARAMS.sort_by, offset, limit: suggestion ? 8 : query.limit });
    const hits = (response.hits ?? []) as Array<{ document: SearchDocument; text_match?: number }>;
    const groupedIds: Record<SearchEntityType, string[]> = { place: [], board: [], collection: [] };
    for (const hit of hits) groupedIds[hit.document.entity_type].push(hit.document.entity_id);
    const current = await readableSummaries(requestSupabase(env, identity?.token), groupedIds);
    const results = hits.flatMap((hit) => { const fresh = current.get(`${hit.document.entity_type}:${hit.document.entity_id}`); return fresh ? [{ ...fresh, score: hit.text_match, } satisfies SearchResult] : []; });
    const nextCursor = hits.length === (suggestion ? 8 : query.limit) ? encodeCursor(offset + hits.length, fp, env.SEARCH_CURSOR_SECRET) : undefined;
    if (suggestion || query.mode === "grouped") {
      const groups = { places: results.filter((r) => r.type === "place"), boards: results.filter((r) => r.type === "board"), collections: results.filter((r) => r.type === "collection") };
      return { query: query.q, tookMs: Date.now() - started, groups, ...(nextCursor ? { nextCursor } : {}) };
    }
    return { query: query.q, tookMs: Date.now() - started, results, ...(nextCursor ? { nextCursor } : {}) };
  });
}

export async function registerSearchRoutes(app: FastifyInstance, env: Env): Promise<void> { await queryRoute(app, env, false); await queryRoute(app, env, true); }
