import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { profileConnect } from "../lib/tauri";
import { useScreenStore } from "../stores/screen";
import { cellToString } from "../utils/convert";
import { TableItem } from "../types";
import { listTablesQuery } from "./queries";
import { runSqlQuery } from "../utils/query";

export function useLoadTables() {
  const { tabs, activeScreen, updateTab } = useScreenStore();

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [tables, setTables] = useState<TableItem[]>([]);

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

      setBusy(true);
      setTables([]);
      // setMsg("Loading tables...");

      try {
        const connectionId = await ensureRuntimeConnection();
        if (!connectionId) {
          setMsg("No active connection.");
          setBusy(false);
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

        setTables(tables);

        setBusy(false);
      } catch (e: any) {
        setMsg(e?.message ? String(e.message) : String(e));
        setBusy(false);
      }
    },
    [activeTab, ensureRuntimeConnection]
  );

  // Auto-load when switch tab (or when runtimeConnectionId changes)
  useEffect(() => {
    if (!activeTab) return;
    void loadTables("public");
  }, [activeTab?.id, loadTables]); // tab switch => reload

  return { tables, msg, busy, loadTables };
}
