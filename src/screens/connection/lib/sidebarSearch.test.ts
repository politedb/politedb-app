import { describe, expect, it } from "vitest";
import { matchesSidebarSearch } from "./sidebarSearch";

describe("matchesSidebarSearch", () => {
  const users = { schema: "public", name: "users" };

  it("matches names only while one schema is shown", () => {
    expect(matchesSidebarSearch(users, "use", "public")).toBe(true);
    expect(matchesSidebarSearch(users, "pub", "public")).toBe(false);
  });

  it("also matches the schema when no schema is picked", () => {
    expect(matchesSidebarSearch(users, "pub", "")).toBe(true);
    expect(matchesSidebarSearch(users, "pub", undefined)).toBe(true);
  });

  it("matches everything for an empty query", () => {
    expect(matchesSidebarSearch(users, "", "public")).toBe(true);
  });
});
