import { describe, expect, it } from "vitest";
import { buildAccessFilter, buildFilter } from "../src/search/filters.js";

describe("access filters", () => {
  it("restricts anonymous users to public non-unlisted documents", () => expect(buildAccessFilter()).toContain("visibility:=public"));
  it("uses verified identity for owner and membership access", () => expect(buildAccessFilter("abc" )).toContain("owner_id:=`abc`"));
  it("composes type and place filters", () => expect(buildFilter({ userId: "abc", types: ["place"], province: "Da Nang" })).toContain("province:=`Da Nang`"));
});
