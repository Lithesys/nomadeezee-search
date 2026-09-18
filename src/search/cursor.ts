import { createHmac, timingSafeEqual } from "node:crypto";

function signature(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
export function encodeCursor(offset: number, fingerprint: string, secret: string): string { const payload = Buffer.from(JSON.stringify({ offset, fingerprint, exp: Date.now() + 15 * 60_000 }), "utf8").toString("base64url"); return `${payload}.${signature(payload, secret)}`; }
export function decodeCursor(cursor: string | undefined, fingerprint: string, secret: string): number {
  if (!cursor) return 0; const [payload, provided] = cursor.split("."); if (!payload || !provided) throw new Error("Invalid cursor");
  const expected = signature(payload, secret); const a = Buffer.from(provided); const b = Buffer.from(expected); if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid cursor");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { offset: number; fingerprint: string; exp: number };
  if (decoded.fingerprint !== fingerprint || decoded.exp < Date.now() || !Number.isInteger(decoded.offset) || decoded.offset < 0) throw new Error("Expired cursor"); return decoded.offset;
}
