import { describe, expect, it } from "vitest";
import type { TableItem } from "src/types";
import {
  getDirectAppContextReply,
  getDirectMetadataReply,
  looksLikeMetadataQuestion,
  wantsSqlGeneration,
  wantsTableData,
} from "./index";

const sampleTables: TableItem[] = [
  { schema: "public", name: "activations" },
  { schema: "public", name: "licenses" },
  { schema: "public", name: "media_asset" },
  { schema: "public", name: "mobile_session" },
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
    expect(wantsTableData("cho tôi dữ liệu users")).toBe(true);
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

describe("getDirectAppContextReply", () => {
  it("answers saved connection count without database schema context", () => {
    const reply = getDirectAppContextReply({
      question: "Số lượng connection hiện tại đã được lưu.",
      savedConnections: [
        { id: "pg", label: "PoliteDB", engine: "postgres", tags: ["prod"] },
        { id: "mysql", label: "MySQL", engine: "mysql", tags: ["local"] },
      ],
    });

    expect(reply?.answer).toContain("2 connection");
  });

  it("lists saved connection names", () => {
    const reply = getDirectAppContextReply({
      question: "liệt kê tên tất cả connection đã lưu",
      savedConnections: [
        { id: "pg", label: "PoliteDB", engine: "postgres", tags: ["prod"] },
      ],
    });

    expect(reply?.answer).toContain("PoliteDB");
    expect(reply?.answer).toContain("postgres");
  });

  it("lists production connection details with prod tag", () => {
    const reply = getDirectAppContextReply({
      question: "cho tôi chi tiết các connection",
      savedConnections: [
        { id: "pg", label: "politedb", engine: "postgres", tags: ["prod"] },
      ],
    });

    expect(reply?.answer).toContain("politedb");
    expect(reply?.answer).toContain("tags=prod");
    expect(reply?.answer).toContain("production");
  });

  it("returns every saved connection with complete safe details", () => {
    const savedConnections = Array.from({ length: 15 }, (_, index) => ({
      id: `connection-${index + 1}`,
      label: `Connection ${index + 1}`,
      engine: "postgres",
      tags: index === 14 ? ["prod"] : ["local"],
      target: `db-${index + 1}.example.test:5432 • database_${index + 1}`,
      user: `user_${index + 1}`,
    }));

    const reply = getDirectAppContextReply({
      question: "cho tôi chi tiết tất cả connection",
      savedConnections,
    });

    expect(reply?.answer).toContain("15 connection");
    expect(reply?.answer).toContain("1. Connection 1;");
    expect(reply?.answer).toContain("15. Connection 15;");
    expect(reply?.answer).toContain("target=db-15.example.test:5432");
    expect(reply?.answer).toContain("user=user_15");
    expect(reply?.answer).toContain("tags=prod");
    expect(reply?.answer).toContain("environment=production");
  });

  it("repeats saved connection details without sending the request to the model", () => {
    const reply = getDirectAppContextReply({
      question: "cho tôi lại",
      history: [
        {
          role: "user",
          text: "cho tôi chi tiết tất cả connection",
        },
      ],
      savedConnections: [
        {
          id: "prod",
          label: "Production DB",
          engine: "postgres",
          tags: ["prod"],
          target: "db.example.test:5432 • app",
        },
      ],
    });

    expect(reply?.answer).toContain("1 connection");
    expect(reply?.answer).toContain("Production DB");
    expect(reply?.answer).toContain("target=db.example.test:5432");
  });

  it("repeats complete connection details in an explicitly requested language", () => {
    const savedConnections = Array.from({ length: 15 }, (_, index) => ({
      id: `connection-${index + 1}`,
      label: `Connection ${index + 1}`,
      engine: "postgres",
      tags: ["local"],
    }));

    const reply = getDirectAppContextReply({
      question: "trả lời tiếng việt đi",
      history: [
        {
          role: "user",
          text: "show details for all saved connections",
        },
      ],
      savedConnections,
    });

    expect(reply?.answer).toContain("Hiện có 15 connection đã lưu");
    expect(reply?.answer).toContain("1. Connection 1;");
    expect(reply?.answer).toContain("15. Connection 15;");
  });
});
