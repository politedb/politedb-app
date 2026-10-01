import type { DatabaseEngine, TableConstraint } from "src/types";
import type { ColumnMeta } from "src/lib/tauri/types";
import { tableKey } from "src/lib/table-data";
import { loadColumns } from "src/lib/table-data/loaders/sqlLoader";
import { useConnectionStore } from "src/stores/connection";
import { getErrorMessage } from "src/lib/table-data/helpers";
import type { StandaloneExportMetadata } from "./types";

export type LoadStandaloneExportMetadataArgs = {
  profileScreenId: string;
  connectionId: string;
  engine: DatabaseEngine;
  schema: string;
  tableName: string;
  /** Row estimate from the database catalog, when available. */
  estimatedRow?: number | string | null;
  /** Optional abort: when true, result must be discarded by caller. */
  isCancelled?: () => boolean;
};

type ColumnLike = {
  name?: string | null;
  db_type?: string | null;
  is_primary?: boolean;
  column_default?: string | null;
};

function asColumnMeta(columns: ColumnLike[]): ColumnMeta[] {
  return columns
    .filter(
      (c): c is ColumnLike & { name: string } =>
        (c.name ?? "").trim().length > 0
    )
    .map((c) => ({
      // Preserve exact identifiers (quoted names may include leading/trailing spaces).
      name: c.name,
      db_type: c.db_type ?? "",
      is_primary: c.is_primary,
      column_default: c.column_default ?? null,
    }));
}

function normalizeRowCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

/**
 * Load only column (+ cached constraint) metadata needed for whole-table export.
 * Reuses connection/schema/table-scoped cache when present. Does not run grid
 * SELECT, COUNT(*), preview sampling, or whole-schema hydration. Does not write
 * query history.
 */
export async function loadStandaloneExportMetadata(
  args: LoadStandaloneExportMetadataArgs
): Promise<StandaloneExportMetadata> {
  const { profileScreenId, connectionId, engine, schema, tableName } = args;
  const key = tableKey(profileScreenId, schema, tableName);
  const store = useConnectionStore.getState();

  const cachedMeta = store.tableDataMap[key];
  const cachedColumns =
    (Array.isArray(cachedMeta?.columns) && cachedMeta!.columns!.length > 0
      ? cachedMeta!.columns
      : null) ??
    (Array.isArray(store.columnsCache[key]) &&
    store.columnsCache[key]!.length > 0
      ? store.columnsCache[key]
      : null);
  // Use the best available count for determinate export progress. Both the
  // catalog value and cached table value may be estimates; the label deliberately
  // presents either one as a plain total without an estimate marker.
  const cachedRowCount = normalizeRowCount(cachedMeta?.rowCount);
  const catalogRowCount = normalizeRowCount(args.estimatedRow);
  const totalRows = cachedRowCount ?? catalogRowCount;

  if (cachedColumns && cachedColumns.length > 0) {
    if (args.isCancelled?.()) {
      throw new Error("Export metadata cancelled.");
    }
    return {
      columns: asColumnMeta(cachedColumns),
      constraints:
        (cachedMeta?.constraints as TableConstraint[] | null) ?? null,
      totalRows,
    };
  }

  // Silent: do not mutate query history with metadata SQL.
  const columns = await loadColumns({
    connId: connectionId,
    schema,
    tableName,
    engine,
    addLogQuery: () => {},
  });

  if (args.isCancelled?.()) {
    throw new Error("Export metadata cancelled.");
  }

  const normalized = asColumnMeta(columns);
  if (normalized.length === 0) {
    throw new Error("No columns found for this table.");
  }

  try {
    useConnectionStore.getState().setColumnsCache(key, normalized);
  } catch {
    // Cache write is best-effort; export can proceed without it.
  }

  return {
    columns: normalized,
    constraints: null,
    totalRows,
  };
}

export function sanitizeStandaloneExportError(err: unknown): string {
  const msg = getErrorMessage(err);
  if (/cancelled/i.test(msg)) return "Export metadata cancelled.";
  if (msg.length > 400) return `${msg.slice(0, 400)}…`;
  return msg || "Failed to load table metadata.";
}
