import { useCallback, useMemo } from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import { cellToString } from "src/utils/convert";
import { useScreenStore } from "src/stores/screen";
import { profileConnect } from "src/lib/tauri/profile";
import {
  tableColumnsQuery,
  tableDataQuery,
  tableRelationshipsQuery,
  tableRowCountQuery,
  tableSizeInfoQuery,
  tableStructuresQuery,
} from "./queries";
import { runSqlQuery } from "src/utils/query";
import { useConnectionStore } from "src/stores/connection";
import { TableRelationships, TableStructure } from "src/types";

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

        // Map structure data from query result to TableStructure format
        const structure: TableStructure[] = structureRes.rows.map(
          (row: any) => ({
            column_name: cellToString(row[1]), // column_name
            data_type: cellToString(row[2]), // data_type (udt_name)
            is_nullable: cellToString(row[8]).toLowerCase() === "yes", // is_nullable
            check: cellToString(row[9]), // CHECK
            column_default: cellToString(row[11]), // column_default
            foreign_key: cellToString(row[12]), // foreign_key
            comment: cellToString(row[13]), // comment
          })
        );

        addTableDataMap(key, {
          data: {
            columns,
            rows: dataRes.rows,
            rowCount: Number(cellToString(rowCountRes.rows[0][0])),
          },
          structure,
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
          structure: null,
          relationships: null,
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
