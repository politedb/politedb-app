import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { profileConnect } from "../lib/tauri";
import { useScreenStore } from "../stores/screen";
import { cellToString } from "../utils/convert";
import { dbSchemasQuery } from "./queries";
import { runSqlQuery } from "../utils/query";

export function useLoadSchemas() {
  const { tabs, activeScreen, updateTab } = useScreenStore();

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);

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

    setBusy(true);
    setSchemas([]);

    try {
      const connectionId = await ensureRuntimeConnection();
      if (!connectionId) {
        setMsg("No active connection.");
        setBusy(false);
        return;
      }

      const schemasRes = await runSqlQuery(connectionId, dbSchemasQuery());
      const schemas: string[] = schemasRes.rows
        .map((r: any) => cellToString(r?.[0]))
        .filter((s: any) => s);

      setSchemas(schemas);

      setBusy(false);
    } catch (e: any) {
      setMsg(e?.message ? String(e.message) : String(e));
      setBusy(false);
    }
  }, [activeTab, ensureRuntimeConnection]);

  // Auto-load when switch tab (or when runtimeConnectionId changes)
  useEffect(() => {
    if (!activeTab) return;
    void loadSchemas();
  }, [activeTab?.id, loadSchemas]); // tab switch => reload

  return { schemas, msg, busy, loadSchemas };
}
