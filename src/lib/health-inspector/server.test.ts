import { describe, expect, it } from "vitest";
import {
  XID_WRAPAROUND_LIMIT,
  buildServerAttentionItems,
  formatPercent,
  isUnusedIndex,
  matchesHealthFilter,
  needsVacuum,
  serverCheckState,
  serverMetricSignals,
} from "./signals";
import { formatCompactCount } from "./format";
import { decodeIndexes, decodeServerMetrics } from "./decode";
import type {
  HealthIndexRow,
  HealthServerMetrics,
  HealthTableRow,
} from "./types";

function server(
  overrides: Partial<HealthServerMetrics> = {}
): HealthServerMetrics {
  return {
    maxXidAge: 10_000_000,
    autovacuumFreezeMaxAge: 200_000_000,
    maxConnections: 100,
    reservedConnections: 3,
    clientConnections: 20,
    canReadAllStats: true,
    blocksHit: 99_000,
    blocksRead: 1_000,
    isStandby: false,
    standbyReplayLagSeconds: null,
    replicaCount: 0,
    maxReplicaLagSeconds: null,
    ...overrides,
  };
}

function table(overrides: Partial<HealthTableRow> = {}): HealthTableRow {
  return {
    schema: "public",
    tableName: "events",
    liveTuples: 8_000,
    deadTuples: 2_000,
    lastVacuum: null,
    lastAutovacuum: null,
    lastAnalyze: null,
    lastAutoAnalyze: null,
    tableBytes: 1,
    indexesBytes: 1,
    totalBytes: 2,
    isPartitionedParent: false,
    isPartitionChild: false,
    ...overrides,
  };
}

function index(overrides: Partial<HealthIndexRow> = {}): HealthIndexRow {
  return {
    schema: "public",
    tableName: "events",
    indexName: "events_kind_idx",
    idxScan: 0,
    idxTupRead: 0,
    idxTupFetch: 0,
    indexBytes: 8192,
    isUnique: false,
    enforcesConstraint: false,
    ...overrides,
  };
}

describe("server metric signals", () => {
  it("is calm on a healthy server", () => {
    const s = serverMetricSignals(server());
    expect(s).toMatchObject({
      xid: "ok",
      connections: "ok",
      cache: "ok",
      replication: "neutral",
    });
    expect(s.cacheHitRatio).toBeCloseTo(0.99);
    expect(buildServerAttentionItems(server())).toEqual([]);
  });

  it("warns as transaction ID age approaches wraparound", () => {
    // Autovacuum falling behind: past 2x autovacuum_freeze_max_age.
    expect(serverMetricSignals(server({ maxXidAge: 450_000_000 })).xid).toBe(
      "warning"
    );
    expect(
      serverMetricSignals(server({ maxXidAge: XID_WRAPAROUND_LIMIT * 0.8 })).xid
    ).toBe("critical");
    const items = buildServerAttentionItems(
      server({ maxXidAge: XID_WRAPAROUND_LIMIT * 0.8 })
    );
    expect(items[0]).toMatchObject({ kind: "xid_wraparound", critical: true });
    expect(items[0]!.title).toBe(
      "Transaction ID age at 80% of the wraparound limit"
    );
  });

  it("compares connections with usable slots", () => {
    expect(
      serverMetricSignals(server({ clientConnections: 78 })).connections
    ).toBe("warning");
    expect(
      serverMetricSignals(server({ clientConnections: 93 })).connections
    ).toBe("critical");
    expect(
      serverMetricSignals(server({ maxConnections: null })).connections
    ).toBe("neutral");
  });

  it("ignores the cache hit ratio until there is traffic", () => {
    expect(
      serverMetricSignals(server({ blocksHit: 10, blocksRead: 90 }))
        .cacheHitRatio
    ).toBeNull();
    expect(
      serverMetricSignals(server({ blocksHit: 8_000, blocksRead: 2_000 })).cache
    ).toBe("warning");
  });

  it("grades replica and standby lag separately", () => {
    expect(
      serverMetricSignals(server({ replicaCount: 2, maxReplicaLagSeconds: 90 }))
        .replication
    ).toBe("warning");
    expect(
      serverMetricSignals(
        server({ replicaCount: 2, maxReplicaLagSeconds: 900 })
      ).replication
    ).toBe("critical");
    // A standby's replay lag also grows while the primary is idle.
    expect(
      serverMetricSignals(
        server({ isStandby: true, standbyReplayLagSeconds: 3_600 })
      ).replication
    ).toBe("warning");
    expect(
      buildServerAttentionItems(
        server({ isStandby: true, standbyReplayLagSeconds: 3_600 })
      )[0]
    ).toMatchObject({ kind: "replication_lag", critical: false });
  });

  it("decodes constraint-backed indexes fail-closed", () => {
    const decode = (value: unknown) =>
      decodeIndexes({
        columns: ["index_name", "idx_scan", "enforces_constraint"].map(
          (name) => ({ name, db_type: "text" })
        ),
        rows: [["i", 0, value]],
        rowCount: 1,
      } as any).rows[0]!.enforcesConstraint;
    expect(decode(false)).toBe(false);
    expect(decode("f")).toBe(false);
    expect(decode(true)).toBe(true);
    expect(decode(null)).toBe(true);
    expect(decode(undefined)).toBe(true);
  });

  it("only treats complete server checks as complete", () => {
    const ready = (data: HealthServerMetrics | null) => ({
      status: "ready",
      data,
    });
    expect(serverCheckState(undefined, true)).toBe("pending");
    expect(serverCheckState({ status: "loading", data: null }, true)).toBe(
      "pending"
    );
    // Cancelled before the server query finished.
    expect(serverCheckState({ status: "loading", data: null }, false)).toBe(
      "incomplete"
    );
    expect(serverCheckState({ status: "error", data: null }, false)).toBe(
      "incomplete"
    );
    expect(serverCheckState({ status: "unavailable", data: null }, false)).toBe(
      "incomplete"
    );
    expect(serverCheckState(ready(server({ maxXidAge: null })), false)).toBe(
      "incomplete"
    );
    expect(serverCheckState(ready(server()), false)).toBe("complete");
  });

  it("decodes the server row", () => {
    const row = (canRead: boolean) =>
      decodeServerMetrics({
        columns: [
          "max_xid_age",
          "max_connections",
          "reserved_connections",
          "role_reserved_connections",
          "can_read_all_stats",
          "client_connections",
          "is_standby",
          "replica_count",
        ].map((name) => ({ name, db_type: "int8" })),
        rows: [["123", 100, 3, 2, canRead, 7, false, 0]],
        rowCount: 1,
      } as any);
    // Without pg_read_all_stats the visible count is only this role's sessions.
    expect(row(false).clientConnections).toBeNull();
    const decoded = row(true);
    expect(decoded).toMatchObject({
      maxXidAge: 123,
      maxConnections: 100,
      reservedConnections: 5,
      canReadAllStats: true,
      clientConnections: 7,
      isStandby: false,
      replicaCount: 0,
      maxReplicaLagSeconds: null,
    });
  });
});

describe("list flags and filtering", () => {
  it("flags tables with many dead rows", () => {
    expect(needsVacuum(table())).toBe(true);
    expect(needsVacuum(table({ deadTuples: 500, liveTuples: 100 }))).toBe(
      false
    );
    expect(needsVacuum(table({ deadTuples: 1_000, liveTuples: 100_000 }))).toBe(
      false
    );
    expect(needsVacuum(table({ deadTuples: null }))).toBe(false);
  });

  it("never flags unique or unknown-scan indexes as unused", () => {
    expect(isUnusedIndex(index())).toBe(true);
    expect(
      isUnusedIndex(index({ isUnique: true, enforcesConstraint: true }))
    ).toBe(false);
    // Non-unique index backing an EXCLUDE constraint.
    expect(isUnusedIndex(index({ enforcesConstraint: true }))).toBe(false);
    expect(isUnusedIndex(index({ idxScan: null }))).toBe(false);
    expect(isUnusedIndex(index({ idxScan: 3 }))).toBe(false);
  });

  it("matches every term case-insensitively across fields", () => {
    expect(matchesHealthFilter(["public.Events", null], "  ")).toBe(true);
    expect(matchesHealthFilter(["public.Events", 42], "events 42")).toBe(true);
    expect(matchesHealthFilter(["public.Events"], "events orders")).toBe(false);
  });

  it("formats percentages and compact counts", () => {
    expect(formatPercent(0.1234, 1)).toBe("12.3%");
    expect(formatPercent(null)).toBe("—");
    expect(formatCompactCount(950)).toBe("950");
    expect(formatCompactCount(12_345)).toBe("12.3K");
    expect(formatCompactCount(152_000_000)).toBe("152M");
    expect(formatCompactCount(1_200_000_000)).toBe("1.2B");
    expect(formatCompactCount(null)).toBe("—");
  });
});
