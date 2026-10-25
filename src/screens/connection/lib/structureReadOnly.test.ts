import { describe, expect, it } from "vitest";
import { structureReadOnlyReason } from "./structureReadOnly";

describe("structureReadOnlyReason", () => {
  it("is null when the structure can be edited", () => {
    expect(structureReadOnlyReason("postgres", false)).toBeNull();
    expect(structureReadOnlyReason("mysql", false)).toBeNull();
  });

  it("explains a locked connection first", () => {
    expect(structureReadOnlyReason("postgres", true)).toMatch(/locked/);
    expect(structureReadOnlyReason("mongo", true)).toMatch(/locked/);
  });

  it("names engines without structure editing", () => {
    expect(structureReadOnlyReason("mongo", false)).toMatch(/MongoDB/);
    expect(structureReadOnlyReason("cassandra", false)).not.toBeNull();
    expect(structureReadOnlyReason("redis", false)).not.toBeNull();
  });
});
