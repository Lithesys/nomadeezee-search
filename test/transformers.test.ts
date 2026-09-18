import { describe, expect, it } from "vitest";
import { boardToSearchDocument, collectionToSearchDocument, placeToSearchDocument } from "../src/transformers/entities.js";

const common = { id: "61f00000-0000-4000-8000-000000000001", title: "Da Nang", description: "Beach", user_id: "61f00000-0000-4000-8000-000000000002", is_public: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" };
describe("transformers", () => {
  it("normalizes place data without raw rows", () => { const doc = placeToSearchDocument({ ...common, category: "beach", latitude: 16.05, longitude: 108.2 }); expect(doc.id).toBe(`place:${common.id}`); expect(doc.location).toEqual([16.05, 108.2]); expect(doc.categories).toEqual(["beach"]); });
  it("maps board ownership and memberships", () => { const doc = boardToSearchDocument({ ...common, owner_id: common.user_id, title: "Weekend" }, ["61f00000-0000-4000-8000-000000000003"]); expect(doc.entity_type).toBe("board"); expect(doc.visibility).toBe("public"); expect(doc.accessible_user_ids).toHaveLength(1); });
  it("maps collection name to title", () => { const doc = collectionToSearchDocument({ ...common, owner_id: common.user_id, name: "Favourites", is_public: false }, []); expect(doc.title).toBe("Favourites"); expect(doc.visibility).toBe("private"); });
});
