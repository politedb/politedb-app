import { useCallback, useEffect, useMemo } from "preact/hooks";
import { profileConnect } from "../lib/tauri";
import { useScreenStore } from "../stores/screen";
import { cellToString } from "../utils/convert";
import { dbSchemasQuery } from "./queries";
import { runSqlQuery } from "../utils/query";
import { useConnectionStore } from "../stores/connection";

export function useLoadSchemas() {
  const { tabs, activeScreen, updateTab } = useScreenStore();
  const { setSchemas } = useConnectionStore();

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

  const loadSchemas = useCallback(async () => {
    if (!activeTab) return;

    setSchemas(activeScreen, { data: [], busy: true, error: null });

    try {
      const connectionId = await ensureRuntimeConnection();
      if (!connectionId) {
        setSchemas(activeScreen, {
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

      setSchemas(activeScreen, { data: schemas, busy: false, error: null });
    } catch (e: any) {
      setSchemas(activeScreen, {
        data: [],
        busy: false,
        error: e?.message ? String(e.message) : String(e),
      });
    }
  }, [activeTab, ensureRuntimeConnection]);

  // Auto-load when switch tab (or when runtimeConnectionId changes)
  useEffect(() => {
    if (!activeTab) return;
    void loadSchemas();
  }, [activeTab?.id, loadSchemas]); // tab switch => reload

  return { loadSchemas };
}
