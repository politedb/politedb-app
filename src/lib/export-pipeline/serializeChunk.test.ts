import { describe, expect, it } from "vitest";
import { REDACTED_TEXT } from "src/lib/export-masking";
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

describe("CSV chunks appended into one file", () => {
  it("keep every row on its own line across chunk boundaries", async () => {
    const { serializeExportChunk } = await import("./serializeChunk");
    const { parseCsvRecords } = await import("src/utils/csv");
    const chunk = (rows: unknown[][], isFirstChunk: boolean) =>
      serializeExportChunk({
        format: "csv",
        columns: ["id", "updated_at"],
        rows,
        isFirstChunk,
        csvOptions: {},
        preserveJsonNulls: false,
        schema: "public",
        tableName: "users",
      });
    const file =
      chunk([["a", "2026-05-22T19:45:39.105027+00:00"]], true) +
      chunk([["b", "2026-05-23T08:00:00+00:00"]], false) +
      chunk([["c", "2026-05-24T08:00:00+00:00"]], false);
    expect(parseCsvRecords(file, ",")).toEqual([
      ["id", "updated_at"],
      ["a", "2026-05-22T19:45:39.105027+00:00"],
      ["b", "2026-05-23T08:00:00+00:00"],
      ["c", "2026-05-24T08:00:00+00:00"],
    ]);
  });

  it("uses the chosen line break between chunks", async () => {
    const { serializeExportChunk } = await import("./serializeChunk");
    const second = serializeExportChunk({
      format: "csv",
      columns: ["id"],
      rows: [["b"]],
      isFirstChunk: false,
      csvOptions: { lineBreak: "\r\n" },
      preserveJsonNulls: false,
      schema: "public",
      tableName: "users",
    });
    expect(second).toBe("\r\nb");
  });
});
