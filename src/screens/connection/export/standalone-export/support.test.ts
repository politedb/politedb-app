import { describe, expect, it } from "vitest";
import {
  canStandaloneExportTable,
  standaloneExportUnavailableReason,
} from "./support";

describe("standalone export support", () => {
  it("allows SQL engines that support table metadata", () => {
    expect(canStandaloneExportTable("postgres")).toBe(true);
    expect(canStandaloneExportTable("mysql")).toBe(true);
    expect(canStandaloneExportTable("sqlite")).toBe(true);
    expect(standaloneExportUnavailableReason("postgres")).toBeNull();
  });

  it("disables redis/mongo/cassandra with a reason", () => {
    expect(canStandaloneExportTable("redis")).toBe(false);
    expect(canStandaloneExportTable("mongo")).toBe(false);
    expect(canStandaloneExportTable("cassandra")).toBe(false);
    expect(standaloneExportUnavailableReason("redis")).toMatch(/Redis/i);
    expect(standaloneExportUnavailableReason("mongo")).toMatch(/Mongo/i);
  });
});
