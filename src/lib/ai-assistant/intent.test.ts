import { describe, expect, it } from "vitest";
import type { TableItem } from "src/types";
import {
  getDirectMetadataReply,
  getFastSqlReply,
  looksLikeMetadataQuestion,
  wantsSqlGeneration,
  wantsTableData,
} from "./index";

const sampleTables: TableItem[] = [
  { schema: "public", name: "activations" },
  { schema: "public", name: "licenses" },
  { schema: "public", name: "polar_license_key_deliveries" },
  { schema: "public", name: "polar_transactions" },
];

describe("wantsSqlGeneration", () => {
  it("detects truncate SQL requests", () => {
    expect(wantsSqlGeneration("give me sql to truncate table licenses")).toBe(
      true
    );
  });

  it("does not treat plain table listing as SQL generation", () => {
    expect(wantsSqlGeneration("show me all tables")).toBe(false);
    expect(wantsSqlGeneration("list tables")).toBe(false);
  });

  it("treats show table data requests as SQL", () => {
    expect(wantsTableData("show data licenses table")).toBe(true);
    expect(wantsSqlGeneration("show data licenses table")).toBe(true);
    expect(looksLikeMetadataQuestion("show data licenses table")).toBe(false);
  });

  it("does not treat list-table-name as metadata listing", () => {
    expect(looksLikeMetadataQuestion("list users")).toBe(false);
    expect(looksLikeMetadataQuestion("list tables")).toBe(true);
  });
});

describe("getDirectMetadataReply", () => {
  it("does not return table list for truncate SQL requests", () => {
    const reply = getDirectMetadataReply({
      engine: "postgres",
      question: "give me sql to truncate table licenses",
      activeSchema: "public",
      tables: sampleTables,
    });

    expect(reply).toBeNull();
  });

  it("still lists tables for metadata questions", () => {
    const reply = getDirectMetadataReply({
      engine: "postgres",
      question: "list tables",
      activeSchema: "public",
      tables: sampleTables,
    });

    expect(reply?.answer).toContain("licenses");
  });
});

describe("getFastSqlReply", () => {
  it("returns SELECT for show data table requests", () => {
    const reply = getFastSqlReply({
      engine: "postgres",
      question: "show data licenses table",
      activeSchema: "public",
      tables: sampleTables,
    });

    expect(reply?.sql).toBe("SELECT * FROM public.licenses LIMIT 50;");
  });

  it("returns TRUNCATE SQL for truncate table requests", () => {
    const reply = getFastSqlReply({
      engine: "postgres",
      question: "truncate table licenses",
      activeSchema: "public",
      tables: sampleTables,
    });

    expect(reply?.sql).toBe("TRUNCATE TABLE public.licenses;");
    expect(reply?.explanation).toContain("Removes all rows");
  });
});
