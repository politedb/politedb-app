import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { listenOp, operationExecute, profileConnect } from "../lib/tauri";
import { useScreenStore } from "../stores/screen";
import { cellToString } from "../utils/convert";

export type TableItem = { schema: string; name: string; connectionId: string };

const LIST_TABLES_SQL = `
select table_schema, table_name
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name;
`.trim();

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

  const loadTables = useCallback(async () => {
    if (!activeTab) return;

    setBusy(true);
    setTables([]);
    setMsg("Loading tables...");

    const buffer: any[][] = [];

    try {
      const connectionId = await ensureRuntimeConnection();
      if (!connectionId) {
        setMsg("No active connection.");
        setBusy(false);
        return;
      }

      const opId = await operationExecute({
        connection_id: connectionId,
        kind: "sql_query",
        sql: { sql: LIST_TABLES_SQL, batch_size: 500, max_rows: 50_000 },
      });

      const unsub = listenOp(
        opId,
        (chunk) => {
          const rows: any[][] = chunk.rows || [];
          buffer.push(...rows);
        },
        () => {
          const parsed: TableItem[] = buffer
            .map((r) => ({
              schema: cellToString(r?.[0]),
              name: cellToString(r?.[1]),
              connectionId,
            }))
            .filter((t) => t.schema && t.name);

          setTables(parsed);
          setMsg(`Loaded ${parsed.length} tables.`);
          setBusy(false);
          unsub();
        },
        (err) => {
          setMsg(`Failed to load tables: ${err?.error || JSON.stringify(err)}`);
          setBusy(false);
          unsub();
        }
      );
    } catch (e: any) {
      setMsg(e?.message ? String(e.message) : String(e));
      setBusy(false);
    }
  }, [activeTab, ensureRuntimeConnection]);

  // Auto-load when switch tab (or when runtimeConnectionId changes)
  useEffect(() => {
    if (!activeTab) return;
    void loadTables();
  }, [activeTab?.id]); // tab switch => reload

  return { tables, msg, busy, loadTables };
}
