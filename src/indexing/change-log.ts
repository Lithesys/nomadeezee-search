import { Pool, type PoolClient } from "pg";
import type Typesense from "typesense";
import type { Env } from "../config/env.js";
import { deleteEntity, upsertEntity } from "./upsert.js";

type Change = { id: string; table_name: "places" | "trip_boards" | "fav_categories"; entity_id: string; operation: "INSERT" | "UPDATE" | "DELETE" };

export function startChangeLogWorker(client: Typesense.Client, env: Env, log: { info: (data: unknown, message: string) => void; warn: (data: unknown, message: string) => void }): (() => Promise<void>) | undefined {
  if (!env.SEARCH_DATABASE_URL) return undefined;
  const pool = new Pool({ connectionString: env.SEARCH_DATABASE_URL, max: 2, ssl: env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
  let running = false;
  const process = async () => {
    if (running) return; running = true;
    let db: PoolClient | undefined;
    try {
      db = await pool.connect(); await db.query("begin");
      const { rows } = await db.query<Change>("select id, table_name, entity_id, operation from public.search_index_changes where processed_at is null order by id asc for update skip locked limit 100");
      await db.query("commit"); db.release(); db = undefined;
      for (const change of rows) {
        try {
          if (change.operation === "DELETE") await deleteEntity(client, env, change.table_name === "places" ? "place" : change.table_name === "trip_boards" ? "board" : "collection", change.entity_id);
          else await upsertEntity(client, env, change.table_name, change.entity_id);
          await pool.query("update public.search_index_changes set processed_at = now(), attempts = attempts + 1, last_error = null where id = $1", [change.id]);
        } catch (error) {
          await pool.query("update public.search_index_changes set attempts = attempts + 1, last_error = left($2, 1000) where id = $1", [change.id, error instanceof Error ? error.message : "Indexing failed"]);
          log.warn({ changeId: change.id }, "Search index change failed");
        }
      }
      if (rows.length) log.info({ count: rows.length }, "Search index change batch processed");
    } catch (error) {
      if (db) { try { await db.query("rollback"); } catch { /* best effort */ } db.release(); }
      log.warn({ error: error instanceof Error ? error.message : "Change log unavailable" }, "Search change log poll failed");
    } finally { running = false; }
  };
  const timer = setInterval(() => void process(), 5_000); timer.unref(); void process();
  return async () => { clearInterval(timer); await pool.end(); };
}
