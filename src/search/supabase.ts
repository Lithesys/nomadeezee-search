import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";
import type { SearchEntityType, SearchResult } from "../types/search.js";

export function serviceSupabase(env: Env): SupabaseClient {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for indexing");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function requestSupabase(env: Env, token?: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
}

const tableByType: Record<SearchEntityType, "places" | "trip_boards" | "fav_categories"> = { place: "places", board: "trip_boards", collection: "fav_categories" };

export async function readableSummaries(client: SupabaseClient, ids: Record<SearchEntityType, string[]>): Promise<Map<string, SearchResult>> {
  const output = new Map<string, SearchResult>();
  for (const type of ["place", "board", "collection"] as const) {
    const wanted = ids[type]; if (!wanted.length) continue;
    const fields = type === "place" ? "id,title,description,province,country,category" : type === "board" ? "id,title,description" : "id,name,description";
    const { data, error } = await client.from(tableByType[type]).select(fields).in("id", wanted);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const id = typeof row.id === "string" ? row.id : undefined; const title = typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : undefined;
      if (!id || !title) continue;
      output.set(`${type}:${id}`, { id, type, title, ...(typeof row.description === "string" && row.description ? { description: row.description } : {}), ...(typeof row.province === "string" ? { province: row.province } : {}), ...(typeof row.country === "string" ? { country: row.country } : {}), ...(typeof row.category === "string" ? { categories: [row.category] } : {}) });
    }
  }
  return output;
}
