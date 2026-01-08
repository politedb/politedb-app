import { useCallback, useEffect, useMemo } from "preact/hooks";
import { profileConnect } from "../lib/tauri";
import { useScreenStore } from "../stores/screen";
import { cellToString } from "../utils/convert";
import { TableItem } from "../types";
import { listTablesQuery } from "./queries";
import { runSqlQuery } from "../utils/query";
import { useConnectionStore } from "../stores/connection";

export function useLoadTables() {
  const { tabs, activeScreen, updateTab } = useScreenStore();
  const { setTables } = useConnectionStore();

  const activeTab = useMemo(() => {
    return tabs.find((t) => t.id === activeScreen) ?? null;
  }, [tabs, activeScreen]);

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

  const loadTables = useCallback(
    async (schema: string = "public") => {
      if (!activeTab) return;

      setTables(activeScreen, { data: [], busy: true, error: null });

      try {
        const connectionId = await ensureRuntimeConnection();
        if (!connectionId) {
          setTables(activeScreen, {
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

        setTables(activeScreen, { data: tables, busy: false, error: null });
      } catch (e: any) {
        setTables(activeScreen, {
          data: [],
          busy: false,
          error: e?.message ? String(e.message) : String(e),
        });
      }
    },
    [activeTab, ensureRuntimeConnection]
  );

  // Auto-load when switch tab (or when runtimeConnectionId changes)
  useEffect(() => {
    if (!activeTab) return;
    void loadTables("public");
  }, [activeTab?.id, loadTables]); // tab switch => reload

  return { loadTables };
}
