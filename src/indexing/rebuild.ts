import type Typesense from "typesense";
import type { Env } from "../config/env.js";
import { serviceSupabase } from "../search/supabase.js";
import { transformEntity } from "../transformers/entities.js";
import { ensureCollection, searchCollectionSchema } from "./typesense-schema.js";

type Table = "places" | "trip_boards" | "fav_categories";
const config: Array<{ table: Table; type: "place" | "board" | "collection"; owner: string }> = [{ table: "places", type: "place", owner: "user_id" }, { table: "trip_boards", type: "board", owner: "owner_id" }, { table: "fav_categories", type: "collection", owner: "owner_id" }];

export interface RebuildStatus { id: string; status: "running" | "complete" | "failed"; startedAt: string; completedAt?: string; error?: string; counts: Record<Table, number>; }
const jobs = new Map<string, RebuildStatus>();
export function getRebuildJob(id: string): RebuildStatus | undefined { return jobs.get(id); }

export function startRebuild(client: Typesense.Client, env: Env): RebuildStatus {
  if ([...jobs.values()].some((job) => job.status === "running")) throw new Error("A rebuild is already running");
  const id = crypto.randomUUID(); const status: RebuildStatus = { id, status: "running", startedAt: new Date().toISOString(), counts: { places: 0, trip_boards: 0, fav_categories: 0 } }; jobs.set(id, status);
  void runRebuild(client, env, status); return status;
}

async function publishRebuiltCollection(client: Typesense.Client, env: Env, physical: string): Promise<void> {
  try {
    await client.aliases(env.SEARCH_INDEX_NAME).retrieve();
  } catch {
    try {
      await client.collections(env.SEARCH_INDEX_NAME).retrieve();
      await client.collections(env.SEARCH_INDEX_NAME).delete();
    } catch {
      // The logical name may not exist yet; alias creation below handles that case.
    }
  }
  await client.aliases().upsert(env.SEARCH_INDEX_NAME, { collection_name: physical });
}

async function runRebuild(client: Typesense.Client, env: Env, status: RebuildStatus): Promise<void> {
  const physical = `${env.SEARCH_INDEX_NAME}_${Date.now()}`;
  try {
    await client.collections().create(searchCollectionSchema(physical)); const supabase = serviceSupabase(env);
    for (const { table, type } of config) {
      let cursor = "";
      while (true) {
        const sourceTable = type === "place" ? "places_with_counts" : table;
        let query = supabase.from(sourceTable).select("*").order("id", { ascending: true }).limit(500); if (cursor) query = query.gt("id", cursor);
        const { data, error } = await query; if (error) throw error; if (!data?.length) break;
        const docs = [];
        for (const row of data as Record<string, unknown>[]) {
          let access: string[] = [];
          if (type === "board" || type === "collection") { const memberTable = type === "board" ? "trip_board_members" : "fav_category_members"; const foreign = type === "board" ? "board_id" : "category_id"; const { data: members, error: memberError } = await supabase.from(memberTable).select("user_id").eq(foreign, row.id); if (memberError) throw memberError; access = (members ?? []).map((m) => m.user_id).filter((v): v is string => typeof v === "string"); }
          docs.push(transformEntity(table, row, access));
        }
        const imported = await client.collections(physical).documents().import(docs, { action: "upsert", batch_size: 500 });
        if (imported.some((line) => !line.success)) throw new Error(`Typesense import failed for ${table}`);
        status.counts[table] += docs.length; cursor = String((data.at(-1) as Record<string, unknown>).id);
      }
    }
    await publishRebuiltCollection(client, env, physical); await ensureCollection(client, env, physical); status.status = "complete"; status.completedAt = new Date().toISOString();
  } catch (error) { status.status = "failed"; status.completedAt = new Date().toISOString(); status.error = error instanceof Error ? error.message : "Rebuild failed"; try { await client.collections(physical).delete(); } catch { /* best effort */ } }
}
