import { describe, expect, it } from "vitest";
import { REDACTED_TEXT } from "src/lib/exportMasking";
import { serializeExportChunk, serializeExportTrailer } from "./serializeChunk";

const SENSITIVE = "SECRET_VALUE_SHOULD_NOT_LEAK";

describe("serializeExportChunk", () => {
  it("preserves JSON nulls when masked", () => {
    const content = serializeExportChunk({
      format: "json",
      columns: ["email", "name"],
      rows: [[{ t: "Null" }, { t: "Str", v: "Ada" }]],
      isFirstChunk: true,
      csvOptions: {},
      preserveJsonNulls: true,
      schema: "public",
      tableName: "users",
    });
    // Streaming first chunk is "[" + object (no closing bracket yet)
    expect(content.startsWith("[")).toBe(true);
    const obj = JSON.parse(content.slice(1));
    expect(obj.email).toBeNull();
    expect(obj.name).toBe("Ada");
  });

  it("writes redacted CSV without sentinel", () => {
    const content = serializeExportChunk({
      format: "csv",
      columns: ["email"],
      rows: [[{ t: "Str", v: REDACTED_TEXT }]],
      isFirstChunk: true,
      csvOptions: { nullToEmpty: false },
      preserveJsonNulls: true,
      schema: "public",
      tableName: "users",
    });
    expect(content).toContain(REDACTED_TEXT);
    expect(content).not.toContain(SENSITIVE);
  });

  it("empty JSON trailer is []", () => {
    expect(
      serializeExportTrailer({
        format: "json",
        totalExported: 0,
        columns: ["a"],
        csvOptions: {},
      })
    ).toBe("[]");
  });
});
