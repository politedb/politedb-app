import { useCallback, useState } from "preact/hooks";
import { confirmDialog, showMessage } from "src/lib/system-dialog";
import { dropTableQuery, truncateTableQuery } from "src/lib/queries/sql";
import type { DatabaseEngine, OpenWindow, TableItem } from "src/types";

export type TruncateOptions = { restartIdentity: boolean; cascade: boolean };

/** Identity of a table across windows and metadata refreshes. */
export function tableIdentity(table: Pick<TableItem, "schema" | "name">) {
  return `${table.schema}\u0000${table.name}`;
}

/** Native confirmation before a table is dropped; resolves true only on "Drop". */
export function confirmDropTable(tableName: string) {
  return confirmDialog(
    `Permanently drop the table "${tableName}" and all its data? This cannot be undone.`,
    {
      title: "Drop table",
      kind: "warning",
      okLabel: "Drop",
      cancelLabel: "Cancel",
    }
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drop and truncate started from the object tree, without opening the table first.
 * Drop asks with a native confirmation; truncate keeps its in-app dialog for the
 * Cascade / Restart identity options. Both are refused while the connection is locked.
 */
export function useTableDestructiveActions(opts: {
  isProfileLocked: boolean;
  engine?: DatabaseEngine;
  connectionId?: string | null;
  windows: OpenWindow[];
  runSqlWithHistory: (args: {
    connectionId: string;
    sql: string;
  }) => Promise<unknown>;
  refreshSchemaAndTables: () => Promise<unknown>;
  closeWindow: (id: string, e: MouseEvent) => Promise<unknown> | unknown;
  /** Asks open views of this table to reload their rows. */
  markTableStale: (key: string) => void;
}) {
  const {
    isProfileLocked,
    engine,
    connectionId,
    windows,
    runSqlWithHistory,
    refreshSchemaAndTables,
    closeWindow,
    markTableStale,
  } = opts;
  const [truncateTarget, setTruncateTarget] = useState<TableItem | null>(null);

  const dropTable = useCallback(
    async (table: TableItem) => {
      if (isProfileLocked || table.new) return;
      if (!(await confirmDropTable(table.name))) return;
      try {
        if (!connectionId) throw new Error("Not connected.");
        const sql = dropTableQuery(table.schema, table.name, engine);
        await runSqlWithHistory({ connectionId, sql });
        await refreshSchemaAndTables();
        const key = tableIdentity(table);
        for (const window of windows) {
          if (window.type === "table" && tableIdentity(window.table) === key) {
            await closeWindow(window.id, new MouseEvent("click"));
          }
        }
      } catch (error) {
        await showMessage(errorMessage(error), {
          title: "Error",
          kind: "error",
        });
      }
    },
    [
      isProfileLocked,
      connectionId,
      engine,
      windows,
      runSqlWithHistory,
      refreshSchemaAndTables,
      closeWindow,
    ]
  );

  const openTruncate = useCallback(
    (table: TableItem) => {
      if (isProfileLocked || table.new) return;
      setTruncateTarget(table);
    },
    [isProfileLocked]
  );

  const closeTruncate = useCallback(() => setTruncateTarget(null), []);

  /** Runs TRUNCATE; errors propagate to the dialog, which reports them. */
  const confirmTruncate = useCallback(
    async (options: TruncateOptions) => {
      const table = truncateTarget;
      if (!table || isProfileLocked) return;
      if (!connectionId) throw new Error("Not connected.");
      const sql = truncateTableQuery(table.schema, table.name, options, engine);
      await runSqlWithHistory({ connectionId, sql });
      markTableStale(tableIdentity(table));
    },
    [
      truncateTarget,
      isProfileLocked,
      connectionId,
      engine,
      runSqlWithHistory,
      markTableStale,
    ]
  );

  return {
    dropTable,
    truncateTarget,
    openTruncate,
    closeTruncate,
    confirmTruncate,
  };
}
