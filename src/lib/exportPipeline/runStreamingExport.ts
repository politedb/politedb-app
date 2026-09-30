import {
  freezePolicy,
  ordinaryPolicy,
  policyHasActiveMasking,
  transformExportChunk,
  validateMaskingPolicy,
  type MaskingPolicy,
} from "src/lib/exportMasking";
import { tableExportQuery } from "src/lib/queries/sql";
import {
  exportSessionAbort,
  exportSessionAppend,
  exportSessionBegin,
  exportSessionPublish,
} from "src/lib/tauri/export";
import { operationCancel } from "src/lib/tauri";
import { operationBus } from "src/lib/tauri/operationBus";
import { startSqlQueryStream } from "src/lib/tauri/query";
import { resolveDefaultTableSort } from "src/utils/tableSort";
import { createSerialWriter } from "./serialWriter";
import { serializeExportChunk, serializeExportTrailer } from "./serializeChunk";
import type {
  ExportConfig,
  ExportOptions,
  ExportProgress,
  FrozenExportRun,
} from "./types";

export type RunStreamingExportHandlers = {
  onProgress: (progress: ExportProgress) => void;
};

export type RunStreamingExportResult = {
  cancel: () => Promise<void>;
  done: Promise<ExportProgress>;
};

function sanitizeExportError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || "Export failed";
    if (msg.length > 400) return `${msg.slice(0, 400)}…`;
    return msg;
  }
  return "Export failed";
}

function resolveProjectedColumns(
  config: ExportConfig,
  policy: MaskingPolicy
): { projected: string[]; output: string[]; policy: MaskingPolicy } {
  const available = (config.columns ?? []).map((c) => c.name).filter(Boolean);
  const validation = validateMaskingPolicy(policy, available);
  if (!validation.ok) {
    throw new Error(validation.error.message);
  }
  return {
    projected: validation.outputColumns,
    output: validation.outputColumns,
    policy,
  };
}

function buildFrozenRun(
  path: string,
  config: ExportConfig,
  opts: ExportOptions
): FrozenExportRun {
  const available = (config.columns ?? []).map((c) => c.name).filter(Boolean);
  let policy: MaskingPolicy;
  if (opts.masked) {
    if (!opts.maskingPolicy) {
      throw new Error("Masked export is missing a masking policy.");
    }
    policy = freezePolicy(opts.maskingPolicy);
    // All-Keep is passthrough: collapse to ordinary semantics (SQL + nulls).
    if (!policyHasActiveMasking(policy)) {
      policy = freezePolicy({ ...policy, masked: false });
    } else if (opts.format === "sql") {
      throw new Error("SQL format is disabled when column masking is applied.");
    }
  } else {
    const selected = opts.columns.length > 0 ? opts.columns : available;
    policy = freezePolicy(ordinaryPolicy(selected));
  }

  const { projected, output } = resolveProjectedColumns(config, policy);
  return {
    path,
    config: {
      ...config,
      appliedFilters: [...config.appliedFilters],
      pagination: config.pagination ? { ...config.pagination } : undefined,
      sortState: config.sortState ? { ...config.sortState } : config.sortState,
      columns: [...(config.columns ?? [])],
    },
    options: {
      ...opts,
      columns: [...opts.columns],
      csvOptions: { ...opts.csvOptions },
      maskingPolicy: policy.masked ? policy : null,
    },
    projectedColumns: projected,
    outputColumns: output,
    policy,
  };
}

/**
 * Streaming table export with serial writes, temp-file publish, and optional masking.
 */
export function runStreamingExport(
  path: string,
  config: ExportConfig,
  opts: ExportOptions,
  handlers: RunStreamingExportHandlers
): RunStreamingExportResult {
  let settle!: (progress: ExportProgress) => void;
  const done = new Promise<ExportProgress>((resolve) => {
    settle = resolve;
  });

  let opId: string | null = null;
  let sessionId: string | null = null;
  let unsub: (() => void) | null = null;
  let cancelled = false;
  let finished = false;
  /** Non-cancellable publish/finalize window; cancel waits for settlement. */
  let committing = false;
  let fatal: string | null = null;
  let totalExported = 0;

  const finish = (progress: ExportProgress) => {
    if (finished) return;
    finished = true;
    handlers.onProgress(progress);
    settle(progress);
  };

  const abortSession = async () => {
    if (!sessionId) return;
    const id = sessionId;
    sessionId = null;
    try {
      await exportSessionAbort(id);
    } catch {
      /* ignore */
    }
  };

  const detachSubscription = () => {
    try {
      unsub?.();
    } catch {
      /* ignore */
    }
    unsub = null;
  };

  const cancelOwnedOperation = async () => {
    if (opId) {
      try {
        await operationCancel(opId);
      } catch {
        /* ignore */
      }
    }
  };

  /** Terminal failure at the export boundary: cancel, cleanup temp, settle once. */
  const failTerminal = async (message: string) => {
    if (finished) return;
    fatal = message;
    cancelled = true;
    detachSubscription();
    await cancelOwnedOperation();
    if (!committing) {
      await abortSession();
    }
    finish({ exported: totalExported, error: fatal });
  };

  const cancelOwned = async () => {
    if (finished) return;
    if (committing) {
      // Publication is non-cancellable; wait so UI cannot report cancelled
      // while the native replace still proceeds.
      await done;
      return;
    }
    cancelled = true;
    detachSubscription();
    await cancelOwnedOperation();
    await abortSession();
    if (!finished) {
      finish({
        exported: totalExported,
        error: fatal ?? "Export cancelled.",
      });
    }
  };

  const start = async () => {
    let frozen: FrozenExportRun;
    try {
      frozen = buildFrozenRun(path, config, opts);
    } catch (e) {
      finish({ exported: 0, error: sanitizeExportError(e) });
      return;
    }

    const { connectionId: connId, schema, tableName, engine } = frozen.config;
    if (!connId) {
      finish({ exported: 0, error: "Not connected." });
      return;
    }
    if (frozen.projectedColumns.length === 0) {
      finish({ exported: 0, error: "No columns to export." });
      return;
    }

    const csvOptions = frozen.policy.masked
      ? {
          ...frozen.options.csvOptions,
          nullToEmpty: false,
        }
      : {
          ...frozen.options.csvOptions,
          nullToEmpty: frozen.options.nullToEmpty !== false,
        };
    const querySort =
      frozen.config.sortState ??
      resolveDefaultTableSort({
        columns: frozen.config.columns,
        constraints: frozen.config.constraints,
        engine,
      });

    const q = tableExportQuery(
      schema,
      tableName,
      frozen.projectedColumns,
      frozen.config.appliedFilters.length
        ? frozen.config.appliedFilters
        : undefined,
      frozen.config.appliedFilterCombine,
      engine,
      frozen.config.pagination,
      querySort
    );

    try {
      const begin = await exportSessionBegin(frozen.path);
      sessionId = begin.sessionId;
    } catch (e) {
      finish({ exported: 0, error: sanitizeExportError(e) });
      return;
    }

    if (cancelled) {
      await abortSession();
      finish({ exported: 0, error: "Export cancelled." });
      return;
    }

    let isFirstChunk = true;
    let firstWriteDone = false;

    const writeContent = async (content: string) => {
      if (!sessionId) throw new Error("Export session missing");
      await exportSessionAppend({
        sessionId,
        content,
        append: firstWriteDone,
      });
      firstWriteDone = true;
    };

    const boundedWriter = createSerialWriter({
      maxPending: 4,
      write: writeContent,
    });

    try {
      opId = await startSqlQueryStream(connId, q, {
        batchSize: 50,
        maxRows: frozen.config.pagination
          ? frozen.config.pagination.limit
          : 10_000_000,
      });
    } catch (e) {
      await abortSession();
      finish({ exported: 0, error: sanitizeExportError(e) });
      return;
    }

    if (cancelled) {
      try {
        await operationCancel(opId);
      } catch {
        /* ignore */
      }
      await abortSession();
      finish({ exported: 0, error: "Export cancelled." });
      return;
    }

    handlers.onProgress({ exported: 0 });

    unsub = await operationBus.subscribe(opId, {
      awaitChunkHandlers: true,
      onChunk: async (chunk) => {
        if (cancelled || fatal || finished) return;
        const rows = chunk.rows ?? [];
        if (rows.length === 0) return;

        const cols =
          chunk.columns?.map((c) => c.name) ?? frozen.projectedColumns;

        const rowsCopy = rows.map((r) => r.slice());

        const transformed = transformExportChunk({
          policy: frozen.policy,
          chunkColumns: cols,
          rows: rowsCopy,
          expectedProjectedColumns: frozen.projectedColumns,
        });

        if (!transformed.ok) {
          boundedWriter.fail(new Error(transformed.error.message));
          await failTerminal(transformed.error.message);
          return;
        }

        try {
          const content = serializeExportChunk({
            format: frozen.options.format,
            columns: transformed.columns,
            rows: transformed.rows,
            isFirstChunk,
            csvOptions,
            preserveJsonNulls: frozen.policy.masked,
            schema,
            tableName,
            engine,
            policy: frozen.policy.masked ? frozen.policy : null,
          });

          if (content.length === 0 && frozen.options.format !== "json") {
            return;
          }

          await boundedWriter.enqueue(content);
          totalExported += transformed.rows.length;
          isFirstChunk = false;
          handlers.onProgress({ exported: totalExported });
        } catch (e) {
          const message = sanitizeExportError(e);
          boundedWriter.fail(e instanceof Error ? e : new Error(message));
          await failTerminal(message);
        }
      },
      onDone: async (doneInfo) => {
        if (finished) return;
        if (cancelled || fatal) {
          await abortSession();
          finish({
            exported: totalExported,
            error: fatal ?? "Export cancelled.",
          });
          return;
        }

        // Enter non-cancellable commit before publish so cancel cannot
        // report cancelled while native publication still replaces the file.
        committing = true;
        try {
          await boundedWriter.drain();
          if (boundedWriter.failed) {
            throw boundedWriter.error ?? new Error("Write failed");
          }

          const trailer = serializeExportTrailer({
            format: frozen.options.format,
            totalExported,
            columns: frozen.outputColumns,
            csvOptions,
          });
          if (trailer) {
            await writeContent(trailer);
          }

          if (!sessionId) throw new Error("Export session missing");
          const publishId = sessionId;
          await exportSessionPublish(publishId);
          sessionId = null;
          boundedWriter.close();

          const truncated = Boolean(doneInfo?.truncated);
          const warning = truncated
            ? "Export stopped at the row limit; output may be incomplete."
            : undefined;
          finish({
            exported: totalExported,
            truncated,
            warning,
          });
        } catch (e) {
          committing = false;
          const message = sanitizeExportError(e);
          boundedWriter.fail(e instanceof Error ? e : new Error(message));
          await abortSession();
          finish({ exported: totalExported, error: message });
        }
      },
      onError: async (err) => {
        if (finished) return;
        const message =
          typeof err === "string"
            ? err
            : sanitizeExportError(err ?? new Error("Export failed"));
        boundedWriter.fail(new Error(message));
        await failTerminal(message);
      },
    });
  };

  void start().catch(async (e) => {
    fatal = sanitizeExportError(e);
    await abortSession();
    finish({ exported: totalExported, error: fatal });
  });

  return {
    cancel: cancelOwned,
    done,
  };
}

/** Test helper: freeze + validate without starting I/O. */
export function prepareFrozenExportRun(
  path: string,
  config: ExportConfig,
  opts: ExportOptions
): FrozenExportRun {
  return buildFrozenRun(path, config, opts);
}
