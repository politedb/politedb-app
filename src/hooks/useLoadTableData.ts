import { useCallback, useMemo } from "preact/hooks";
import type { ColumnMeta } from "../lib/tauri/types";
import { cellToString } from "../utils/convert";
import { useScreenStore } from "../stores/screen";
import { profileConnect } from "../lib/tauri/profile";
import {
  tableColumnsQuery,
  tableDataQuery,
  tableRelationshipsQuery,
  tableRowCountQuery,
  tableSizeInfoQuery,
  tableStructuresQuery,
} from "./queries";
import { runSqlQuery } from "../utils/query";
import { useConnectionStore } from "../stores/connection";
import { TableRelationships, TableStructure } from "../types";

export function tableKey(
  activeScreen: string,
  schema: string,
  tableName: string
) {
  return `${activeScreen}.${schema}.${tableName}`;
}

type Pagination = {
  limit: number;
  offset: number;
};

export function useLoadTableData() {
  const { tableDataMap, addTableDataMap, removeTableDataMap, addQueryHistory } =
    useConnectionStore();
  const { profileTabs, activeProfileScreen } = useScreenStore();

  const activeTab = useMemo(() => {
    if (!activeProfileScreen || activeProfileScreen === "main") return null;
    return profileTabs.find((t) => t.id === activeProfileScreen) ?? null;
  }, [profileTabs, activeProfileScreen]);

  const ensureRuntimeConn = useCallback(
    async (tableKey: string) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");

      const tableData = tableDataMap[tableKey];
      if (tableData?.connectionId) return tableData.connectionId;

      const res = await profileConnect(activeTab.profileId);
      const runtimeId = res.connection.id;

      return runtimeId;
    },
    [activeTab]
  );

  const loadTableData = useCallback(
    async (schema: string, tableName: string, pagination?: Pagination) => {
      const key = tableKey(activeProfileScreen, schema, tableName);

      addTableDataMap(key, {
        data: null,
        structure: null,
        relationships: null,
        sizeInfo: null,
        connectionId: null,
        busy: true,
        error: null,
      });

      try {
        const connId = await ensureRuntimeConn(key);

        const columnQuery = tableColumnsQuery(schema, tableName);
        const colRes = await runSqlQuery(connId, columnQuery);
        const columns: ColumnMeta[] = colRes.rows
          .map((r: any) => ({
            name: cellToString(r?.[0]),
            db_type: cellToString(r?.[1]),
          }))
          .filter((c: any) => c.name);

        addQueryHistory(activeTab!.id, {
          sql: columnQuery,
          timestamp: new Date(),
        });

        const dataQuery = tableDataQuery(
          schema,
          tableName,
          pagination?.limit,
          pagination?.offset
        );
        const dataRes = await runSqlQuery(connId, dataQuery);
        addQueryHistory(activeTab!.id, {
          sql: dataQuery,
          timestamp: new Date(),
        });

        const sizeInfoQuery = tableSizeInfoQuery(schema, tableName);
        const sizeInfoRes = await runSqlQuery(connId, sizeInfoQuery);
        addQueryHistory(activeTab!.id, {
          sql: sizeInfoQuery,
          timestamp: new Date(),
        });

        const rowCountQuery = tableRowCountQuery(schema, tableName);
        const rowCountRes = await runSqlQuery(connId, rowCountQuery);
        addQueryHistory(activeTab!.id, {
          sql: rowCountQuery,
          timestamp: new Date(),
        });

        const structureQuery = tableStructuresQuery(schema, tableName);
        const structureRes = await runSqlQuery(connId, structureQuery);
        addQueryHistory(activeTab!.id, {
          sql: structureQuery,
          timestamp: new Date(),
        });

        const relationshipsQuery = tableRelationshipsQuery(schema, tableName);
        const relationshipsRes = await runSqlQuery(connId, relationshipsQuery);
        addQueryHistory(activeTab!.id, {
          sql: relationshipsQuery,
          timestamp: new Date(),
        });

        addTableDataMap(key, {
          data: {
            columns,
            rows: dataRes.rows,
            rowCount: Number(cellToString(rowCountRes.rows[0][0])),
          },
          structure: structureRes.rows as unknown as TableStructure[],
          relationships:
            relationshipsRes.rows as unknown as TableRelationships[],
          sizeInfo: {
            totalSize: cellToString(sizeInfoRes.rows[0][0]),
            dataSize: cellToString(sizeInfoRes.rows[0][1]),
            indexSize: cellToString(sizeInfoRes.rows[0][2]),
          },
          connectionId: connId,
          busy: false,
          error: null,
        });
      } catch (e: any) {
        const msg =
          e?.error ||
          (e?.message ? String(e.message) : String(e)) ||
          "UNKNOWN_ERROR";

        addTableDataMap(key, {
          data: null,
          structure: null,
          relationships: null,
          sizeInfo: null,
          connectionId: null,
          busy: false,
          error: msg,
        });
      }
    },
    [activeProfileScreen, ensureRuntimeConn]
  );

  const getTableData = useCallback(
    (activeScreen: string, schema: string, tableName: string) => {
      const key = tableKey(activeScreen, schema, tableName);
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

  const removeTableData = useCallback(
    (schema: string, tableName: string) => {
      const key = tableKey(activeProfileScreen, schema, tableName);
      removeTableDataMap(key);
    },
    [activeProfileScreen]
  );

  return {
    loadTableData,
    getTableData,
    removeTableData,
  };
}
