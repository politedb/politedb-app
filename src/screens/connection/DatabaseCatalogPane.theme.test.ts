import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const catalog = readFileSync(
  resolve(process.cwd(), "src/screens/connection/DatabaseCatalogPane.tsx"),
  "utf8"
);

describe("DatabaseCatalogPane theme", () => {
  it("uses CanvasTable instead of a light HTML data table", () => {
    expect(catalog).toContain("CanvasTable");
    expect(catalog).not.toContain("common-data-table");
    expect(catalog).not.toContain("odd:bg-white");
    expect(catalog).not.toContain("even:bg-neutral-50");
    expect(catalog).not.toContain("hover:bg-blue-100");
  });
});
