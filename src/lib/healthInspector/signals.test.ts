import { describe, expect, it } from "vitest";
import {
  deadRowRatio,
  formatAgeSeconds,
  indexScanSignal,
  overviewVisibilityNote,
} from "./signals";

describe("healthInspector signals", () => {
  it("keeps unknown stats unknown and treats zero scans as a signal only", () => {
    expect(
      indexScanSignal({
        schema: "s",
        tableName: "t",
        indexName: "i",
        idxScan: null,
        idxTupRead: null,
        idxTupFetch: null,
        indexBytes: null,
      })
    ).toBe("unknown");
    expect(
      indexScanSignal({
        schema: "s",
        tableName: "t",
        indexName: "i",
        idxScan: 0,
        idxTupRead: 0,
        idxTupFetch: 0,
        indexBytes: 1,
      })
    ).toBe("zero");
    expect(
      indexScanSignal({
        schema: "s",
        tableName: "t",
        indexName: "i",
        idxScan: 3,
        idxTupRead: 1,
        idxTupFetch: 1,
        indexBytes: 1,
      })
    ).toBe("used");
  });

  it("computes dead-row ratio only when estimates exist", () => {
    expect(
      deadRowRatio({
        schema: "s",
        tableName: "t",
        liveTuples: null,
        deadTuples: 10,
        lastVacuum: null,
        lastAutovacuum: null,
        lastAnalyze: null,
        lastAutoAnalyze: null,
        tableBytes: null,
        indexesBytes: null,
        totalBytes: null,
        isPartitionedParent: false,
        isPartitionChild: false,
      })
    ).toBeNull();
    expect(
      deadRowRatio({
        schema: "s",
        tableName: "t",
        liveTuples: 90,
        deadTuples: 10,
        lastVacuum: null,
        lastAutovacuum: null,
        lastAnalyze: null,
        lastAutoAnalyze: null,
        tableBytes: null,
        indexesBytes: null,
        totalBytes: null,
        isPartitionedParent: false,
        isPartitionChild: false,
      })
    ).toBeCloseTo(0.1);
  });

  it("formats ages", () => {
    expect(formatAgeSeconds(null)).toBe("—");
    expect(formatAgeSeconds(0.2)).toBe("<1s");
    expect(formatAgeSeconds(90)).toBe("1m 30s");
    expect(formatAgeSeconds(3900)).toBe("1h 5m");
  });

  it("warns when overview visibility is restricted", () => {
    expect(
      overviewVisibilityNote({
        databaseName: "app",
        sessionCount: 5,
        activeSessionCount: null,
        idleSessionCount: null,
        blockedSessionCount: 0,
        longestXactAgeSeconds: null,
        hiddenQueryCount: 0,
        restrictedActivityCount: 2,
        databaseBytes: 1,
        statsReset: null,
        restrictedVisibility: true,
      })
    ).toMatch(/insufficient privilege/i);
  });
});
