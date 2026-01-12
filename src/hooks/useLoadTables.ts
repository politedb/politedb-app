import { useCallback, useMemo } from "preact/hooks";
import { profileConnect } from "../lib/tauri";
import { useScreenStore } from "../stores/screen";
import { cellToString } from "../utils/convert";
import { TableItem } from "../types";
import { dbSchemasQuery, listTablesQuery } from "./queries";
import { runSqlQuery } from "../utils/query";
import { useConnectionStore } from "../stores/connection";

export function useLoadTables() {
  const { profileTabs, activeProfileScreen, updateTab } = useScreenStore();
  const { setTables, setSchemas } = useConnectionStore();

  const activeTab = useMemo(() => {
    return profileTabs.find((t) => t.id === activeProfileScreen) ?? null;
  }, [profileTabs, activeProfileScreen]);

  const ensureRuntimeConnection = useCallback(async () => {
    if (!activeTab?.profileId) return null;

    // reuse if exists
    if (activeTab.runtimeConnectionId) return activeTab.runtimeConnectionId;

    // ask backend to connect from saved profile (resolve keychain inside backend)
    const res = await profileConnect(activeTab.profileId);
    const connId = res.connection.id;

    // persist to tab store
    updateTab(activeTab.id, { runtimeConnectionId: connId });

    return connId;
  }, [activeTab, updateTab]);

  const loadSchemaAndTables = useCallback(
    async (schema: string = "public") => {
      if (!activeTab) return;

      setTables(activeTab.id, { data: [], busy: true, error: null });
      setSchemas(activeTab.id, { data: [], busy: true, error: null });

      try {
        const connectionId = await ensureRuntimeConnection();
        if (!connectionId) {
          setTables(activeTab.id, {
            data: [],
            busy: false,
            error: "No active connection.",
          });
          return;
        }

        const tablesRes = await runSqlQuery(
          connectionId,
          listTablesQuery(schema)
        );

        const tables: TableItem[] = tablesRes.rows
          .map((r: any) => ({
            schema: cellToString(r?.[0]),
            name: cellToString(r?.[1]),
          }))
          .filter((t: any) => t.schema && t.name);

        setTables(activeTab.id, { data: tables, busy: false, error: null });

        const schemasRes = await runSqlQuery(connectionId, dbSchemasQuery());
        const schemas: string[] = schemasRes.rows
          .map((r: any) => cellToString(r?.[0]))
          .filter((s: any) => s);

        setSchemas(activeTab.id, { data: schemas, busy: false, error: null });
      } catch (e: any) {
        setTables(activeTab.id, {
          data: [],
          busy: false,
          error: e?.message ? String(e.message) : String(e),
        });
        setSchemas(activeTab.id, {
          data: [],
          busy: false,
          error: e?.message ? String(e.message) : String(e),
        });
      }
    },
    [activeTab, activeProfileScreen, ensureRuntimeConnection]
  );

  const loadSchemas = useCallback(async () => {
    if (!activeTab) return;

    setSchemas(activeTab.id, { data: [], busy: true, error: null });

    try {
      const connectionId = await ensureRuntimeConnection();
      console.log("loadSchemas connectionId", activeTab, connectionId);

      if (!connectionId) {
        setSchemas(activeTab.id, {
          data: [],
          busy: false,
          error: "No active connection.",
        });
        return;
      }

      const schemasRes = await runSqlQuery(connectionId, dbSchemasQuery());
      const schemas: string[] = schemasRes.rows
        .map((r: any) => cellToString(r?.[0]))
        .filter((s: any) => s);

      setSchemas(activeTab.id, { data: schemas, busy: false, error: null });
    } catch (e: any) {
      setSchemas(activeTab.id, {
        data: [],
        busy: false,
        error: e?.message ? String(e.message) : String(e),
      });
    }
  }, [activeTab, ensureRuntimeConnection]);

  return { loadSchemaAndTables, loadSchemas };
}
