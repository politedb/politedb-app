import { describe, expect, it } from "vitest";
import {
  decodeDumbBinary,
  encodeDumbBinary,
  isPoliteDbDumbBinary,
  packSqlToDumb,
  unpackDumpBytes,
  buildDumbHeader,
  DUMB_MAGIC,
} from "./politedbDumbFormat";

describe("politedbDumbFormat", () => {
  it("detects magic", () => {
    expect(isPoliteDbDumbBinary(DUMB_MAGIC)).toBe(true);
    expect(isPoliteDbDumbBinary(new TextEncoder().encode("-- SQL"))).toBe(
      false
    );
  });

  it("roundtrips gzipped SQL for any engine label", async () => {
    const sql = [
      "-- PoliteDB database backup",
      "-- Engine: postgres",
      "INSERT INTO t VALUES (1, '[\"*\"]', E'a\\\\nb');",
      "",
    ].join("\n");

    const bytes = await packSqlToDumb({ sql, engine: "postgres" });
    expect(isPoliteDbDumbBinary(bytes)).toBe(true);

    const unpacked = await unpackDumpBytes(bytes);
    expect(unpacked.binary).toBe(true);
    expect(unpacked.engine).toBe("postgres");
    expect(unpacked.sql).toBe(sql);
  });

  it("roundtrips mysql engine tag", async () => {
    const sql = "CREATE TABLE t (id INT);\n";
    const bytes = await packSqlToDumb({ sql, engine: "mysql" });
    const unpacked = await unpackDumpBytes(bytes);
    expect(unpacked.engine).toBe("mysql");
    expect(unpacked.sql).toBe(sql);
  });

  it("accepts legacy plain SQL bytes", async () => {
    const sql = "-- Engine: sqlite\nSELECT 1;\n";
    const unpacked = await unpackDumpBytes(new TextEncoder().encode(sql));
    expect(unpacked.binary).toBe(false);
    expect(unpacked.sql).toBe(sql);
  });

  it("encode/decode framing without gzip", () => {
    const header = buildDumbHeader({ engine: "duckdb" });
    const payload = new TextEncoder().encode("SELECT 1;");
    const file = encodeDumbBinary({ header, payload, gzip: false });
    const decoded = decodeDumbBinary(file);
    expect(decoded.gzip).toBe(false);
    expect(decoded.header.engine).toBe("duckdb");
    expect(new TextDecoder().decode(decoded.payload)).toBe("SELECT 1;");
  });
});
