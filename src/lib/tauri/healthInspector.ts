import {
  healthInspectorCapabilitiesSql,
  healthInspectorIndexesSql,
  healthInspectorOverviewSql,
  healthInspectorSessionsSql,
  healthInspectorStatementsInfoSql,
  healthInspectorStatementsSql,
  healthInspectorTablesSql,
  type HealthInspectorStatementsCapability,
} from "src/lib/queries/sql/healthInspector";
import {
  decodeCapabilities,
  decodeIndexes,
  decodeOverview,
  decodeSessions,
  decodeStatements,
  decodeStatementsInfo,
  decodeTables,
  isPermissionOrMissingRelationError,
  sanitizeHealthError,
} from "src/lib/healthInspector/decode";
import { isAbortError, runSqlQuery } from "src/lib/tauri/query";
import type {
  HealthIndexRow,
  HealthInspectorSnapshot,
  HealthOverview,
  HealthSection,
  HealthSessionRow,
  HealthStatementRow,
  HealthStatementsInfo,
  HealthTableRow,
} from "src/lib/healthInspector/types";

export const HEALTH_INSPECTOR_QUERY_TIMEOUT_MS = 10_000;
export const HEALTH_INSPECTOR_OVERALL_DEADLINE_MS = 30_000;

type RunInternal = typeof runSqlQuery;

export type CollectHealthSnapshotArgs = {
  runtimeConnectionId: string;
  profileId: string;
  engine: string;
  signal?: AbortSignal;
  /** Injectable for tests */
  runSql?: RunInternal;
  now?: () => number;
};

function emptySection<T>(data: T): HealthSection<T> {
  return {
    status: "loading",
    collectedAt: null,
    error: null,
    truncated: false,
    unavailableReason: null,
    data,
  };
}

function loadingSnapshot(
  args: CollectHealthSnapshotArgs,
  startedAt: number
): HealthInspectorSnapshot {
  return {
    runtimeConnectionId: args.runtimeConnectionId,
    profileId: args.profileId,
    engine: args.engine,
    startedAt,
    finishedAt: null,
    overallError: null,
    cancelled: false,
    overview: emptySection<HealthOverview | null>(null),
    sessions: emptySection<HealthSessionRow[]>([]),
    statements: {
      ...emptySection<HealthStatementRow[]>([]),
      info: null,
    },
    tables: emptySection<HealthTableRow[]>([]),
    indexes: emptySection<HealthIndexRow[]>([]),
  };
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
}

function remainingMs(deadlineAt: number, now: () => number): number {
  return Math.max(0, deadlineAt - now());
}

async function runSectionQuery(
  runSql: RunInternal,
  connectionId: string,
  sql: string,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  now: () => number
) {
  assertNotAborted(signal);
  const left = remainingMs(deadlineAt, now);
  if (left <= 0) {
    throw new Error("SQL_QUERY_TIMEOUT");
  }
  const timeoutMs = Math.min(HEALTH_INSPECTOR_QUERY_TIMEOUT_MS, left);
  return runSql(connectionId, sql, {
    timeoutMs,
    maxRows: 200,
    batchSize: 100,
    signal,
    internal: true,
  });
}

/**
 * Collect one on-demand health snapshot.
 * Sequential queries only; ≤10 statements including capability checks.
 * Partial section failures degrade that section only.
 */
export async function collectHealthInspectorSnapshot(
  args: CollectHealthSnapshotArgs
): Promise<HealthInspectorSnapshot> {
  const now = args.now ?? Date.now;
  const runSql = args.runSql ?? runSqlQuery;
  const startedAt = now();
  const deadlineAt = startedAt + HEALTH_INSPECTOR_OVERALL_DEADLINE_MS;
  const snap = loadingSnapshot(args, startedAt);
  let statementCount = 0;

  const bump = () => {
    statementCount += 1;
    if (statementCount > 10) {
      throw new Error("HEALTH_INSPECTOR_STATEMENT_BUDGET_EXCEEDED");
    }
  };

  try {
    // 1) Overview
    try {
      bump();
      const result = await runSectionQuery(
        runSql,
        args.runtimeConnectionId,
        healthInspectorOverviewSql(),
        args.signal,
        deadlineAt,
        now
      );
      snap.overview = {
        status: "ready",
        collectedAt: now(),
        error: null,
        truncated: false,
        unavailableReason: null,
        data: decodeOverview(result),
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      const msg = sanitizeHealthError(err);
      snap.overview = {
        status: isPermissionOrMissingRelationError(msg)
          ? "unavailable"
          : "error",
        collectedAt: now(),
        error: msg,
        truncated: false,
        unavailableReason: isPermissionOrMissingRelationError(msg) ? msg : null,
        data: null,
      };
    }

    // 2) Sessions
    try {
      bump();
      const result = await runSectionQuery(
        runSql,
        args.runtimeConnectionId,
        healthInspectorSessionsSql(),
        args.signal,
        deadlineAt,
        now
      );
      const decoded = decodeSessions(result);
      snap.sessions = {
        status: decoded.rows.length === 0 ? "empty" : "ready",
        collectedAt: now(),
        error: null,
        truncated: decoded.truncated,
        unavailableReason: null,
        data: decoded.rows,
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      const msg = sanitizeHealthError(err);
      snap.sessions = {
        status: isPermissionOrMissingRelationError(msg)
          ? "unavailable"
          : "error",
        collectedAt: now(),
        error: msg,
        truncated: false,
        unavailableReason: isPermissionOrMissingRelationError(msg) ? msg : null,
        data: [],
      };
    }

    // 3) Capabilities for statements
    let statementsCap: HealthInspectorStatementsCapability | null = null;
    try {
      bump();
      const result = await runSectionQuery(
        runSql,
        args.runtimeConnectionId,
        healthInspectorCapabilitiesSql(),
        args.signal,
        deadlineAt,
        now
      );
      const caps = decodeCapabilities(result);
      if (
        caps.statementsAvailable &&
        caps.statementsSchema &&
        caps.totalTimeColumn
      ) {
        statementsCap = {
          schema: caps.statementsSchema,
          totalTimeColumn: caps.totalTimeColumn,
          meanTimeColumn: caps.meanTimeColumn,
          hasInfoView: caps.hasInfoView,
        };
      } else {
        snap.statements = {
          status: "unavailable",
          collectedAt: now(),
          error: null,
          truncated: false,
          unavailableReason:
            caps.unavailableReason ??
            "pg_stat_statements is not available in this database.",
          data: [],
          info: null,
        };
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      const msg = sanitizeHealthError(err);
      snap.statements = {
        status: "unavailable",
        collectedAt: now(),
        error: msg,
        truncated: false,
        unavailableReason: msg,
        data: [],
        info: null,
      };
    }

    // 4–5) Statements + optional info
    if (statementsCap) {
      let info: HealthStatementsInfo | null = null;
      if (statementsCap.hasInfoView) {
        try {
          bump();
          const infoResult = await runSectionQuery(
            runSql,
            args.runtimeConnectionId,
            healthInspectorStatementsInfoSql(statementsCap.schema),
            args.signal,
            deadlineAt,
            now
          );
          info = decodeStatementsInfo(infoResult);
        } catch (err) {
          if (isAbortError(err)) throw err;
          // info is optional; continue without it
          info = null;
        }
      }

      try {
        bump();
        const result = await runSectionQuery(
          runSql,
          args.runtimeConnectionId,
          healthInspectorStatementsSql(statementsCap),
          args.signal,
          deadlineAt,
          now
        );
        const decoded = decodeStatements(result);
        snap.statements = {
          status: decoded.rows.length === 0 ? "empty" : "ready",
          collectedAt: now(),
          error: null,
          truncated: decoded.truncated,
          unavailableReason: null,
          data: decoded.rows,
          info,
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        const msg = sanitizeHealthError(err);
        snap.statements = {
          status: isPermissionOrMissingRelationError(msg)
            ? "unavailable"
            : "error",
          collectedAt: now(),
          error: msg,
          truncated: false,
          unavailableReason: isPermissionOrMissingRelationError(msg)
            ? msg
            : null,
          data: [],
          info,
        };
      }
    }

    // 6) Tables
    try {
      bump();
      const result = await runSectionQuery(
        runSql,
        args.runtimeConnectionId,
        healthInspectorTablesSql(),
        args.signal,
        deadlineAt,
        now
      );
      const decoded = decodeTables(result);
      snap.tables = {
        status: decoded.rows.length === 0 ? "empty" : "ready",
        collectedAt: now(),
        error: null,
        truncated: decoded.truncated,
        unavailableReason: null,
        data: decoded.rows,
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      const msg = sanitizeHealthError(err);
      snap.tables = {
        status: isPermissionOrMissingRelationError(msg)
          ? "unavailable"
          : "error",
        collectedAt: now(),
        error: msg,
        truncated: false,
        unavailableReason: isPermissionOrMissingRelationError(msg) ? msg : null,
        data: [],
      };
    }

    // 7) Indexes
    try {
      bump();
      const result = await runSectionQuery(
        runSql,
        args.runtimeConnectionId,
        healthInspectorIndexesSql(),
        args.signal,
        deadlineAt,
        now
      );
      const decoded = decodeIndexes(result);
      snap.indexes = {
        status: decoded.rows.length === 0 ? "empty" : "ready",
        collectedAt: now(),
        error: null,
        truncated: decoded.truncated,
        unavailableReason: null,
        data: decoded.rows,
      };
    } catch (err) {
      if (isAbortError(err)) throw err;
      const msg = sanitizeHealthError(err);
      snap.indexes = {
        status: isPermissionOrMissingRelationError(msg)
          ? "unavailable"
          : "error",
        collectedAt: now(),
        error: msg,
        truncated: false,
        unavailableReason: isPermissionOrMissingRelationError(msg) ? msg : null,
        data: [],
      };
    }

    snap.finishedAt = now();
    return snap;
  } catch (err) {
    if (isAbortError(err)) {
      snap.cancelled = true;
      snap.finishedAt = now();
      snap.overallError = "Cancelled";
      return snap;
    }
    snap.finishedAt = now();
    snap.overallError = sanitizeHealthError(err);
    return snap;
  }
}

/** Max statements used by a full snapshot path (for tests / docs). */
export const HEALTH_INSPECTOR_MAX_STATEMENTS = 7;
