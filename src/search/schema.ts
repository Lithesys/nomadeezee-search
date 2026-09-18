import { z } from "zod";
import type { SearchEntityType } from "../types/search.js";

const type = z.enum(["place", "board", "collection"]);
const csv = z.string().transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean)).pipe(z.array(z.string()).max(20));

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  types: csv.pipe(z.array(type).max(3)).optional(),
  categories: csv.pipe(z.array(z.string().min(1).max(80))).optional(),
  province: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(2000).optional(),
  mode: z.enum(["global", "grouped"]).default("global"),
}).strict().superRefine((value, ctx) => {
  const geoCount = [value.lat, value.lng, value.radiusKm].filter((v) => v !== undefined).length;
  if (geoCount !== 0 && geoCount !== 3) ctx.addIssue({ code: "custom", message: "lat, lng, and radiusKm must be supplied together" });
  if ((value.categories || value.province || value.country || geoCount) && value.types?.some((t: string) => t !== "place")) ctx.addIssue({ code: "custom", message: "place filters require types=place" });
});

export type SearchQuery = z.infer<typeof searchQuerySchema> & { types?: SearchEntityType[] };
