import { useCallback, useMemo, useState } from "preact/hooks";
import type { ColumnMeta } from "../lib/tauri/types";
import { cellToString } from "../utils/convert";
import { useScreenStore } from "../stores/screen";
import { profileConnect } from "../lib/tauri/profile";
import { TableData, TableSizeInfo } from "../types";
import {
  tableColumnsQuery,
  tableDataQuery,
  tableSizeInfoQuery,
} from "./queries";
import { runSqlQuery } from "../utils/query";

type TableDataState = Record<
  string,
  {
    data: TableData | null;
    sizeInfo: TableSizeInfo | null;
    connectionId: string | null;
    busy: boolean;
    error: string | null;
  }
>;

function tableKey(schema: string, tableName: string) {
  return `${schema}.${tableName}`;
}

type Pagination = {
  page: number;
  pageSize: number;
};

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
        [key]: {
          data: null,
          sizeInfo: null,
          connectionId: null,
          busy: true,
          error: null,
        },
      }));

      try {
        const connId = await ensureRuntimeConn(key);

        const colRes = await runSqlQuery(
          connId,
          tableColumnsQuery(schema, tableName)
        );

        const columns: ColumnMeta[] = colRes.rows
          .map((r: any) => ({
            name: cellToString(r?.[0]),
            db_type: cellToString(r?.[1]),
          }))
          .filter((c: any) => c.name);

        const limit = pagination?.pageSize ?? 1000;
        const offset = (pagination?.page ?? 0) * limit;
        const dataRes = await runSqlQuery(
          connId,
          tableDataQuery(schema, tableName, limit, offset)
        );

        const sizeInfoRes = await runSqlQuery(
          connId,
          tableSizeInfoQuery(schema, tableName)
        );

        setTableDataMap((prev) => ({
          ...prev,
          [key]: {
            data: { columns, rows: dataRes.rows, rowCount: dataRes.rowCount },
            sizeInfo: {
              totalSize: cellToString(sizeInfoRes.rows[0][0]),
              dataSize: cellToString(sizeInfoRes.rows[0][1]),
              indexSize: cellToString(sizeInfoRes.rows[0][2]),
            },
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
          [key]: {
            data: null,
            sizeInfo: null,
            connectionId: null,
            busy: false,
            error: msg,
          },
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
          sizeInfo: null,
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
