import type { SearchDocument, SearchEntityType, SearchVisibility } from "../types/search.js";

type Row = Record<string, unknown>;

function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function uuid(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Entity id is invalid"); return value; }
function unix(value: unknown): number { const time = typeof value === "string" || value instanceof Date ? new Date(value).getTime() : Number(value); return Number.isFinite(time) ? Math.floor(time / 1000) : Math.floor(Date.now() / 1000); }
function visibility(isPublic: unknown, accessible: string[]): SearchVisibility { return isPublic === true ? "public" : accessible.length ? "shared" : "private"; }
function owner(row: Row, field: "user_id" | "owner_id"): string { return uuid(row[field]); }
function accessIds(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) : []; }
function optionalString(field: string, row: Row): string | undefined { return stringValue(row[field]); }
function base(row: Row, type: SearchEntityType, ownerField: "user_id" | "owner_id", titleField: string, accessible: string[]): SearchDocument {
  const entityId = uuid(row.id);
  const title = stringValue(row[titleField]);
  if (!title) throw new Error(`${type} title is required`);
  const description = stringValue(row.description);
  const province = optionalString("province", row);
  const country = optionalString("country", row);
  const categories = Array.isArray(row.categories) ? row.categories.filter((v): v is string => typeof v === "string") : [];
  return {
    id: `${type}:${entityId}`, entity_id: entityId, entity_type: type, title, ...(description ? { description } : {}),
    searchable_text: [title, description, province, country, ...categories].filter(Boolean).join(" "),
    ...(province ? { province } : {}), ...(country ? { country } : {}), categories,
    visibility: visibility(row.is_public, accessible), owner_id: owner(row, ownerField), accessible_user_ids: accessible,
    popularity_score: Math.min(1000, Math.max(0, Number(row.like_count) || 0)), created_at: unix(row.created_at), updated_at: unix(row.updated_at ?? row.created_at),
  };
}

export function placeToSearchDocument(row: Row, accessible: string[] = []): SearchDocument {
  const doc = base({ ...row, categories: row.category ? [row.category] : [] }, "place", "user_id", "title", accessible);
  const latitude = Number(row.latitude); const longitude = Number(row.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) doc.location = [latitude, longitude];
  return doc;
}

export function boardToSearchDocument(row: Row, accessible: string[] = []): SearchDocument { return base(row, "board", "owner_id", "title", accessible); }
export function collectionToSearchDocument(row: Row, accessible: string[] = []): SearchDocument { return base(row, "collection", "owner_id", "name", accessible); }

export function transformEntity(table: "places" | "trip_boards" | "fav_categories", row: Row, accessible: string[] = []): SearchDocument {
  if (table === "places") return placeToSearchDocument(row, accessible);
  if (table === "trip_boards") return boardToSearchDocument(row, accessible);
  return collectionToSearchDocument(row, accessible);
}
