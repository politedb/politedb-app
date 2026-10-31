import { useCallback, useMemo, useState } from "preact/hooks";
import { runSqlQuery } from "src/lib/tauri/query";
import { createSchemaQuery, createTableQuery } from "src/lib/queries/sql";
import { sqlForDisplay } from "src/lib/sql/sqlDialect";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";
import { connectTabOnce } from "src/lib/runtimeConnection";
import { assertTabTarget } from "src/lib/tabs/assertTabTarget";
import type { TableColumn } from "src/types";
import { normalizeSqlError } from "src/lib/tauri/queryValidate";

interface ICreateTable {
  payload: {
    schema: string;
    tableName: string;
    primaryKey: string | string[];
    columns: TableColumn[];
  };
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

export function useCreateSchemaTable() {
  const { profileTabs, activeProfileScreen } = useScreenStore();
  const { addSchema, addQueryHistory } = useConnectionStore();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeTab = useMemo(() => {
    return profileTabs.find((t) => t.id === activeProfileScreen) ?? null;
  }, [profileTabs, activeProfileScreen]);

  const ensureRuntimeConnection = useCallback(async () => {
    if (!activeTab?.profileId) return null;

    // reuse if exists
    if (activeTab.runtimeConnectionId) return activeTab.runtimeConnectionId;

    // Connect on what the tab was opened on (installs it on the tab).
    return connectTabOnce(activeTab.id);
  }, [activeTab]);

  const createSchema = useCallback(
    async (schema: string, onSuccess?: () => void) => {
      if (!activeTab) return;

      setBusy(true);
      setError(null);

      try {
        const connId = await ensureRuntimeConnection();
        if (!connId) return;
        assertTabTarget(activeTab.id, connId);

        const query = createSchemaQuery(schema);
        addQueryHistory(activeTab.id, sqlForDisplay(query, activeTab.engine));

        await runSqlQuery(connId, query);

        addSchema(activeTab.id, schema);

        setBusy(false);
        onSuccess?.();
      } catch (e: any) {
        const msg =
          e?.error ||
          (e?.message ? String(e.message) : String(e)) ||
          "UNKNOWN_ERROR";

        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [activeTab, addQueryHistory, addSchema, ensureRuntimeConnection]
  );

  const createTable = useCallback(
    async ({ payload, onSuccess, onError }: ICreateTable) => {
      if (!activeTab) return;

      setBusy(true);
      setError(null);

      try {
        const connId = await ensureRuntimeConnection();
        if (!connId) {
          setError("No active connection.");
          setBusy(false);
          return;
        }
        assertTabTarget(activeTab.id, connId);

        const { schema, tableName, columns, primaryKey } = payload;
        const query = createTableQuery(
          schema,
          tableName,
          columns,
          primaryKey,
          activeTab.engine
        );
        addQueryHistory(activeTab.id, sqlForDisplay(query, activeTab.engine));

        await runSqlQuery(connId, query);

        setBusy(false);
        onSuccess?.();
      } catch (e: any) {
        const msg = normalizeSqlError(e);
        setError(msg);
        setBusy(false);
        onError?.(msg);
      }
    },
    [activeTab, ensureRuntimeConnection, addQueryHistory]
  );

  return {
    busy,
    error,
    setError,
    createSchema,
    createTable,
  };
}
