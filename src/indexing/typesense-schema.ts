import type Typesense from "typesense";
import type { Env } from "../config/env.js";
import type { CollectionCreateSchema } from "typesense/lib/Typesense/Collections.js";

export const searchCollectionSchema = (name: string): CollectionCreateSchema => ({ name, fields: [
  { name: "entity_id", type: "string" }, { name: "entity_type", type: "string", facet: true },
  { name: "title", type: "string" }, { name: "description", type: "string", optional: true }, { name: "searchable_text", type: "string", optional: true },
  { name: "image_url", type: "string", optional: true }, { name: "categories", type: "string[]", facet: true, optional: true },
  { name: "province", type: "string", facet: true, optional: true }, { name: "country", type: "string", facet: true, optional: true },
  { name: "location", type: "geopoint", optional: true }, { name: "visibility", type: "string", facet: true }, { name: "owner_id", type: "string", facet: true },
  { name: "accessible_user_ids", type: "string[]", facet: true, optional: true }, { name: "popularity_score", type: "int32" }, { name: "created_at", type: "int64" }, { name: "updated_at", type: "int64" },
], default_sorting_field: "popularity_score" });

export async function ensureCollection(client: Typesense.Client, env: Env, physicalName = env.SEARCH_INDEX_NAME): Promise<void> {
  try { await client.collections(physicalName).retrieve(); } catch { await client.collections().create(searchCollectionSchema(physicalName)); }
  if (physicalName !== env.SEARCH_INDEX_NAME) {
    try { await client.aliases(env.SEARCH_INDEX_NAME).retrieve(); } catch { await client.aliases().upsert(env.SEARCH_INDEX_NAME, { collection_name: physicalName }); }
  }
}
