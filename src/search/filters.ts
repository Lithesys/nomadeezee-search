import type { SearchEntityType } from "../types/search.js";

export function escapeTypesenseValue(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

export function buildAccessFilter(userId?: string): string {
  if (!userId) return "(visibility:=public && visibility:!=unlisted)";
  const identity = escapeTypesenseValue(userId);
  return `(visibility:=public || owner_id:=${identity} || accessible_user_ids:=${identity}) && visibility:!=unlisted`;
}

export function buildFilter(options: {
  userId?: string; types?: SearchEntityType[]; categories?: string[]; province?: string; country?: string;
  geo?: { lat: number; lng: number; radiusKm: number };
}): string {
  const filters = [buildAccessFilter(options.userId)];
  if (options.types?.length) filters.push(`entity_type:=[${options.types.join(",").replaceAll(" ", "")}]`);
  if (options.categories?.length) filters.push(`categories:=[${options.categories.map(escapeTypesenseValue).join(",")}]`);
  if (options.province) filters.push(`province:=${escapeTypesenseValue(options.province)}`);
  if (options.country) filters.push(`country:=${escapeTypesenseValue(options.country)}`);
  if (options.geo) filters.push(`location:(${options.geo.lat}, ${options.geo.lng}, ${options.geo.radiusKm} km)`);
  return filters.join(" && ");
}
