import { describe, expect, it } from "vitest";
import {
  LONG_TRANSACTION_WARN_SECONDS,
  buildAttentionItems,
  formatLongestTransaction,
  overviewMetricTones,
  splitAttentionItems,
  deadRowRatio,
  formatAgeSeconds,
  indexScanSignal,
  overviewVisibilityNote,
} from "./signals";
import type { HealthOverview } from "./types";

function baseOverview(overrides: Partial<HealthOverview> = {}): HealthOverview {
  return {
    databaseName: "app",
    sessionCount: 5,
    activeSessionCount: 1,
    idleSessionCount: 2,
    blockedSessionCount: 0,
    longestXactAgeSeconds: 1,
    hiddenQueryCount: 0,
    restrictedActivityCount: 0,
    databaseBytes: 1,
    statsReset: "2024-01-01T00:00:00Z",
    restrictedVisibility: false,
    idleInTransactionCount: 0,
    idleInTransactionOldestXactAgeSeconds: null,
    idleInTransactionLongestIdleSeconds: null,
    topBlockers: [],
    hasUnresolvedBlockers: false,
    lockWaitDurationAvailable: false,
    tempFiles: 0,
    tempBytes: 0,
    deadlocks: 0,
    ...overrides,
  };
}

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
      overviewVisibilityNote(
        baseOverview({
          activeSessionCount: null,
          idleSessionCount: null,
          longestXactAgeSeconds: null,
          restrictedActivityCount: 2,
          restrictedVisibility: true,
        })
      )
    ).toMatch(/insufficient privilege/i);
  });

  it("builds attention for blocked and idle-in-transaction, not temp-only", () => {
    const withTempOnly = buildAttentionItems(
      baseOverview({ tempFiles: 99, tempBytes: 1_000_000 })
    );
    expect(withTempOnly.find((i) => i.kind === "blocked")).toBeUndefined();
    expect(withTempOnly).toHaveLength(0);

    const blocked = buildAttentionItems(
      baseOverview({
        blockedSessionCount: 2,
        topBlockers: [
          {
            pid: 0,
            blockedSessionCount: 1,
            inCurrentDatabase: false,
            isPreparedTransaction: true,
          },
          {
            pid: 42,
            blockedSessionCount: 1,
            inCurrentDatabase: true,
            isPreparedTransaction: false,
          },
        ],
        hasUnresolvedBlockers: true,
      })
    );
    expect(blocked.some((i) => i.kind === "blocked")).toBe(true);
    expect(blocked.find((i) => i.kind === "blocked")?.evidence).toMatch(
      /PID 0|prepared/i
    );
    expect(blocked.find((i) => i.kind === "blocked")?.evidence).toMatch(
      /lock-wait duration unavailable/i
    );
    expect(blocked.find((i) => i.kind === "blocked")?.openSessions).toBe(true);

    const idle = buildAttentionItems(
      baseOverview({
        idleInTransactionCount: 2,
        idleInTransactionOldestXactAgeSeconds: 120,
        idleInTransactionLongestIdleSeconds: 30,
      })
    );
    expect(idle.some((i) => i.kind === "idle_in_transaction")).toBe(true);
    expect(
      idle.find((i) => i.kind === "idle_in_transaction")?.evidence
    ).toMatch(/transaction age/i);
  });

  it("labels historical deadlocks as informational history, not current blocking", () => {
    const items = buildAttentionItems(baseOverview({ deadlocks: 4 }));
    const dead = items.find((i) => i.kind === "deadlocks_history");
    expect(dead?.tone).toBe("informational");
    expect(dead?.title).toMatch(/since stats reset/i);
    expect(dead?.evidence).toMatch(/historical/i);
    expect(dead?.openSessions).toBe(false);
  });

  it("surfaces incomplete visibility instead of healthy", () => {
    const items = buildAttentionItems(
      baseOverview({
        restrictedVisibility: true,
        activeSessionCount: null,
        idleSessionCount: null,
        idleInTransactionCount: null,
      })
    );
    expect(items.some((i) => i.kind === "incomplete")).toBe(true);
    expect(items.every((i) => i.kind !== "blocked" || true)).toBe(true);
  });

  it("colors cards by thresholds and keeps unknown values neutral", () => {
    expect(overviewMetricTones(baseOverview())).toEqual({
      blocked: "ok",
      idleInTransaction: "ok",
      longestTransaction: "ok",
    });
    expect(
      overviewMetricTones(
        baseOverview({
          blockedSessionCount: 1,
          idleInTransactionCount: 2,
          longestXactAgeSeconds: LONG_TRANSACTION_WARN_SECONDS + 1,
        })
      )
    ).toEqual({
      blocked: "critical",
      idleInTransaction: "warning",
      longestTransaction: "warning",
    });
    expect(
      overviewMetricTones(
        baseOverview({
          restrictedVisibility: true,
          blockedSessionCount: null,
          idleInTransactionCount: null,
          longestXactAgeSeconds: null,
        })
      )
    ).toEqual({
      blocked: "neutral",
      idleInTransaction: "neutral",
      longestTransaction: "neutral",
    });
  });

  it("says None running only when no transaction is visible", () => {
    expect(
      formatLongestTransaction(baseOverview({ longestXactAgeSeconds: null }))
    ).toBe("None running");
    expect(
      formatLongestTransaction(
        baseOverview({
          longestXactAgeSeconds: null,
          restrictedVisibility: true,
        })
      )
    ).toBe("—");
    expect(
      formatLongestTransaction(baseOverview({ longestXactAgeSeconds: 90 }))
    ).toBe("1m 30s");
  });

  it("flags long transactions unless the idle one already explains it", () => {
    const long = buildAttentionItems(
      baseOverview({ longestXactAgeSeconds: 600 })
    );
    expect(long.find((i) => i.kind === "long_transaction")?.title).toBe(
      "Transaction open for 10m"
    );
    expect(
      buildAttentionItems(baseOverview({ longestXactAgeSeconds: 300 })).some(
        (i) => i.kind === "long_transaction"
      )
    ).toBe(false);
    const idle = buildAttentionItems(
      baseOverview({
        longestXactAgeSeconds: 600,
        idleInTransactionCount: 1,
        idleInTransactionOldestXactAgeSeconds: 600,
      })
    );
    expect(idle.map((i) => i.kind)).toEqual(["idle_in_transaction"]);
  });

  it("separates current issues from history", () => {
    const items = buildAttentionItems(
      baseOverview({ blockedSessionCount: 1, deadlocks: 2 })
    );
    const { issues, history } = splitAttentionItems(items);
    expect(issues.map((i) => i.kind)).toEqual(["blocked"]);
    expect(history.map((i) => i.kind)).toEqual(["deadlocks_history"]);
  });
});
