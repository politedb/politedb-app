import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { connectionCreate, listenOp, operationExecute } from "../lib/tauri";
import { useScreenStore } from "../stores/screen";
import { cellToString } from "../utils/convert";

export type TableItem = {
  schema: string;
  name: string;
};

const LIST_TABLES_SQL = `
select table_schema, table_name
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name;
`.trim();

export function useLoadTables() {
  const { tabs, activeScreen } = useScreenStore();

  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");
  const [tables, setTables] = useState<TableItem[]>([]);
  const [sessionIdState, setSessionIdState] = useState<string | null>(null);

  const activeTab = useMemo(() => {
    return tabs.find((tab) => tab.id === activeScreen);
  }, [activeScreen]);

  const loadTables = useCallback(
    async (connId: string) => {
      if (!connId || !activeTab?.connectionData) return;

      setBusy(true);
      setTables([]);
      setMsg("Loading tables...");

      const res = await connectionCreate(activeTab.connectionData);

      const buffer: any[][] = [];

      try {
        const storeKey = activeTab.id.split("#").pop() || "";
        const localData = JSON.parse(localStorage.getItem(storeKey) || "{}");
        if (localData.id) {
          localStorage.setItem(storeKey, JSON.stringify({ ...localData, connectionId: res.id }));
        }

        const opId = await operationExecute({
          connection_id: res.id,
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
    },
    [activeTab?.connectionData]
  );

  useEffect(() => {
    if (activeTab?.connectionId && activeTab.connectionId !== sessionIdState) {
      loadTables(activeTab.id);
      setSessionIdState(activeTab.connectionId);
    }
  }, [activeTab?.connectionId]);

  return {
    tables,
    msg,
    busy,
    loadTables: () => sessionIdState && loadTables(sessionIdState),
  };
}
