import type { DatabaseEngine } from "src/types";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { TableConstraint } from "src/types";

/** Immutable identity for one standalone export request. */
export type StandaloneExportTarget = {
  /** Monotonic / unique per request; used to drop stale metadata completions. */
  requestId: string;
  connectionId: string;
  engine: DatabaseEngine;
  schema: string;
  tableName: string;
  kind?: "table" | "view";
  /** Row estimate captured from the catalog when the export was requested. */
  estimatedRow?: number | string;
};

export type StandaloneExportMetadata = {
  columns: ColumnMeta[];
  constraints: TableConstraint[] | null;
  /** Best available cached or catalog row estimate; null when unavailable. */
  totalRows: number | null;
};

export type StandaloneExportPhase =
  | { status: "idle" }
  | { status: "loading"; target: StandaloneExportTarget }
  | {
      status: "error";
      target: StandaloneExportTarget;
      message: string;
    }
  | {
      status: "ready";
      target: StandaloneExportTarget;
      metadata: StandaloneExportMetadata;
    };
