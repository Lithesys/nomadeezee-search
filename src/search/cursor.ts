import { createHmac, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

function signature(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
export function encodeCursor(offset: number, fingerprint: string, secret: string): string { const payload = Buffer.from(JSON.stringify({ offset, fingerprint, exp: Date.now() + 15 * 60_000 }), "utf8").toString("base64url"); return `${payload}.${signature(payload, secret)}`; }
export function decodeCursor(cursor: string | undefined, fingerprint: string, secret: string): number {
  if (!cursor) return 0; const [payload, provided] = cursor.split("."); if (!payload || !provided) throw new Error("Invalid cursor");
  const expected = signature(payload, secret); const a = Buffer.from(provided); const b = Buffer.from(expected); if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid cursor");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { offset: number; fingerprint: string; exp: number };
  if (decoded.fingerprint !== fingerprint || decoded.exp < Date.now() || !Number.isInteger(decoded.offset) || decoded.offset < 0) throw new Error("Expired cursor"); return decoded.offset;
}

export interface RecommendationCursor {
  seed: string;
  excludedPlaceIds: string[];
}

export function encodeRecommendationCursor(value: RecommendationCursor, fingerprint: string, secret: string): string {
  const payload = deflateRawSync(Buffer.from(JSON.stringify({ ...value, fingerprint, exp: Date.now() + 15 * 60_000 }), "utf8")).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function decodeRecommendationCursor(cursor: string | undefined, fingerprint: string, secret: string): RecommendationCursor {
  if (!cursor) return { seed: "", excludedPlaceIds: [] };
  const [payload, provided] = cursor.split(".");
  if (!payload || payload.length > 16000 || !provided) throw new Error("Invalid cursor");
  const expected = signature(payload, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid cursor");
  const decoded = JSON.parse(inflateRawSync(Buffer.from(payload, "base64url"), { maxOutputLength: 64_000 }).toString("utf8")) as {
    seed: unknown;
    excludedPlaceIds: unknown;
    fingerprint: string;
    exp: number;
  };
  if (
    decoded.fingerprint !== fingerprint
    || decoded.exp < Date.now()
    || typeof decoded.seed !== "string"
    || !Array.isArray(decoded.excludedPlaceIds)
    || decoded.excludedPlaceIds.length > 500
    || decoded.excludedPlaceIds.some((id) => typeof id !== "string")
  ) throw new Error("Expired cursor");
  return { seed: decoded.seed, excludedPlaceIds: decoded.excludedPlaceIds as string[] };
}
