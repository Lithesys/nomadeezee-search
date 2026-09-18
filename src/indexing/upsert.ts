import type Typesense from "typesense";
import type { Env } from "../config/env.js";
import { serviceSupabase } from "../search/supabase.js";
import { transformEntity } from "../transformers/entities.js";
import type { SearchEntityType, SearchDocument } from "../types/search.js";

const tableByType: Record<SearchEntityType, "places" | "trip_boards" | "fav_categories"> = { place: "places", board: "trip_boards", collection: "fav_categories" };
const typeByTable = { places: "place", trip_boards: "board", fav_categories: "collection" } as const;

async function currentDocument(env: Env, table: keyof typeof typeByTable, id: string): Promise<SearchDocument | null> {
  const supabase = serviceSupabase(env); const type = typeByTable[table];
  const { data: row, error } = await supabase.from(tableByType[type]).select("*").eq("id", id).maybeSingle();
  if (error) throw error; if (!row) return null;
  const membershipTable = type === "board" ? "trip_board_members" : type === "collection" ? "fav_category_members" : null;
  let access: string[] = [];
  if (membershipTable) {
    const foreign = type === "board" ? "board_id" : "category_id";
    const { data, error: membershipError } = await supabase.from(membershipTable).select("user_id").eq(foreign, id);
    if (membershipError) throw membershipError; access = (data ?? []).map((item) => item.user_id).filter((v): v is string => typeof v === "string");
  }
  return transformEntity(table, row as Record<string, unknown>, access);
}

export async function upsertEntity(client: Typesense.Client, env: Env, table: keyof typeof typeByTable, id: string): Promise<"upserted" | "deleted"> {
  const doc = await currentDocument(env, table, id);
  if (!doc) { await deleteEntity(client, env, typeByTable[table], id); return "deleted"; }
  await client.collections(env.SEARCH_INDEX_NAME).documents().upsert(doc);
  return "upserted";
}

export async function deleteEntity(client: Typesense.Client, env: Env, type: SearchEntityType, id: string): Promise<void> {
  try { await client.collections(env.SEARCH_INDEX_NAME).documents(`${type}:${id}`).delete(); } catch (error) { if ((error as { httpStatus?: number }).httpStatus !== 404) throw error; }
}
