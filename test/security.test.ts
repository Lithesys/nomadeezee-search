import { describe, expect, it } from "vitest";
import { equalSecret } from "../src/security/secrets.js";
import { encodeCursor, decodeCursor } from "../src/search/cursor.js";

describe("security helpers", () => {
  it("compares secrets without accepting missing values", () => { expect(equalSecret(undefined, "secret")).toBe(false); expect(equalSecret("secret", "secret")).toBe(true); expect(equalSecret("other", "secret")).toBe(false); });
  it("signs cursors and rejects tampering", () => { const cursor = encodeCursor(20, "fingerprint", "a-secret-that-is-long"); expect(decodeCursor(cursor, "fingerprint", "a-secret-that-is-long")).toBe(20); expect(() => decodeCursor(`${cursor}x`, "fingerprint", "a-secret-that-is-long")).toThrow(); });
});
