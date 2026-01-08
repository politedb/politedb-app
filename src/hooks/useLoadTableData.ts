import { useCallback, useMemo, useState } from "preact/hooks";
import { listenOp, operationExecute } from "../lib/tauri";
import type { ColumnMeta, TableChunk } from "../lib/tauri/types";
import { cellToString } from "../utils/convert";
import { useScreenStore } from "../stores/screen";
import { profileConnect } from "../lib/tauri/profile";

export type TableData = {
  columns: ColumnMeta[];
  rows: any[][];
  rowCount: number;
};

type TableDataState = Record<
  string,
  {
    data: TableData | null;
    connectionId: string | null;
    busy: boolean;
    error: string | null;
  }
>;

function tableKey(schema: string, tableName: string) {
  return `${schema}.${tableName}`;
}

function qIdent(ident: string) {
  return `"${String(ident).replace(/"/g, `""`)}"`;
}

function qLiteral(v: string) {
  return `'${String(v).replace(/"/g, `""`)}'`;
}

type QueryResult = { rows: any[][]; rowCount: number };

type Pagination = {
  page: number;
  pageSize: number;
};

function runSqlQuery(connection_id: string, sql: string) {
  return new Promise<QueryResult>(async (resolve, reject) => {
    try {
      const opId = await operationExecute({
        connection_id,
        kind: "sql_query",
        sql: { sql, batch_size: 200, max_rows: 50_000 },
      });

      const buffer: any[][] = [];

      const unsub = listenOp(
        opId,
        (chunk: TableChunk) => {
          const rows = chunk.rows || [];
          if (rows.length) buffer.push(...rows);
        },
        (done: any) => {
          unsub();
          resolve({ rows: buffer, rowCount: done?.row_count ?? buffer.length });
        },
        (err: any) => {
          unsub();
          reject(err);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}

export function useLoadTableData() {
  const [tableDataMap, setTableDataMap] = useState<TableDataState>({});

  const { tabs, activeScreen, setRuntimeConnectionId } = useScreenStore();

  const activeTab = useMemo(() => {
    if (!activeScreen || activeScreen === "main") return null;
    return tabs.find((t) => t.id === activeScreen) ?? null;
  }, [tabs, activeScreen]);

  const ensureRuntimeConn = useCallback(
    async (tableKey: string) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");

      const tableData = tableDataMap[tableKey];
      if (tableData?.connectionId) return tableData.connectionId;

      const res = await profileConnect(activeTab.profileId);
      const runtimeId = res.connection.id;

      return runtimeId;
    },
    [activeTab, setRuntimeConnectionId]
  );

  const loadTableData = useCallback(
    async (schema: string, tableName: string, pagination?: Pagination) => {
      const key = tableKey(schema, tableName);

      setTableDataMap((prev) => ({
        ...prev,
        [key]: { data: null, connectionId: null, busy: true, error: null },
      }));

      try {
        const connId = await ensureRuntimeConn(key);

        const columnsSql = `
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = ${qLiteral(schema)}
            AND table_name   = ${qLiteral(tableName)}
          ORDER BY ordinal_position;
        `.trim();

        const colRes = await runSqlQuery(connId, columnsSql);

        const columns: ColumnMeta[] = colRes.rows
          .map((r) => ({
            name: cellToString(r?.[0]),
            db_type: cellToString(r?.[1]),
          }))
          .filter((c) => c.name);

        const limit = pagination?.pageSize ?? 1000;
        const offset = (pagination?.page ?? 0) * limit;
        const tableIdent = `${qIdent(schema)}.${qIdent(tableName)}`;
        const dataSql = `SELECT * FROM ${tableIdent} LIMIT ${limit} OFFSET ${offset};`;
        const dataRes = await runSqlQuery(connId, dataSql);

        setTableDataMap((prev) => ({
          ...prev,
          [key]: {
            data: { columns, rows: dataRes.rows, rowCount: dataRes.rowCount },
            connectionId: connId,
            busy: false,
            error: null,
          },
        }));
      } catch (e: any) {
        const msg =
          e?.error ||
          (e?.message ? String(e.message) : String(e)) ||
          "UNKNOWN_ERROR";

        setTableDataMap((prev) => ({
          ...prev,
          [key]: { data: null, connectionId: null, busy: false, error: msg },
        }));
      }
    },
    [ensureRuntimeConn]
  );

  const getTableData = useCallback(
    (schema: string, tableName: string) => {
      const key = tableKey(schema, tableName);
      return (
        tableDataMap[key] || {
          data: null,
          connectionId: null,
          busy: false,
          error: null,
        }
      );
    },
    [tableDataMap]
  );

  const removeTableData = useCallback((schema: string, tableName: string) => {
    const key = tableKey(schema, tableName);
    setTableDataMap((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  return {
    loadTableData,
    getTableData,
    removeTableData,
  };
}
