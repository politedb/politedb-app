import { useCallback, useMemo } from "preact/hooks";
import { cellToString } from "src/utils/convert";
import { useScreenStore } from "src/stores/screen";
import { profileConnect } from "src/lib/tauri/profile";
import {
  tableColumnsQuery,
  tableDataQuery,
  tableOidQuery,
  tableConstraintsQuery,
  tableRowCountQuery,
  tableSizeInfoQuery,
  tableStructuresQuery,
} from "./queries";
import { runSqlQuery } from "src/utils/query";
import { useConnectionStore } from "src/stores/connection";

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

  const addLogQuery = useCallback(
    (sql: string) => {
      addQueryHistory(activeTab!.id, sql);
    },
    [activeTab, addQueryHistory]
  );

  const loadTableData = useCallback(
    async (schema: string, tableName: string, pagination?: Pagination) => {
      const key = tableKey(activeProfileScreen, schema, tableName);

      addTableDataMap(key, {
        data: null,
        structure: null,
        constraints: null,
        sizeInfo: null,
        connectionId: null,
        busy: true,
        error: null,
      });

      try {
        const connId = await ensureRuntimeConn(key);

        const columnQuery = tableColumnsQuery(schema, tableName);
        const colRes = await runSqlQuery(connId, columnQuery);
        addLogQuery(columnQuery);

        const dataQuery = tableDataQuery(schema, tableName, pagination);
        const dataRes = await runSqlQuery(connId, dataQuery);
        addLogQuery(dataQuery);

        const sizeInfoQuery = tableSizeInfoQuery(schema, tableName);
        const sizeInfoRes = await runSqlQuery(connId, sizeInfoQuery);
        addLogQuery(sizeInfoQuery);

        const rowCountQuery = tableRowCountQuery(schema, tableName);
        const rowCountRes = await runSqlQuery(connId, rowCountQuery);
        addLogQuery(rowCountQuery);

        const oidQuery = tableOidQuery(schema, tableName);
        const oidRes = await runSqlQuery(connId, oidQuery);
        const oid = Number(cellToString(oidRes.rows[0][0]));
        addLogQuery(oidQuery);

        const structureQuery = tableStructuresQuery(schema, tableName, oid);
        const structureRes = await runSqlQuery(connId, structureQuery);
        addLogQuery(structureQuery);

        const constraintsQuery = tableConstraintsQuery(schema, tableName);
        const constraintsRes = await runSqlQuery(connId, constraintsQuery);
        addLogQuery(constraintsQuery);

        addTableDataMap(key, {
          data: {
            columns: colRes.rows
              .map((r: any) => ({
                name: cellToString(r?.[0]),
                db_type: cellToString(r?.[1]),
              }))
              .filter((c: any) => c.name),
            rows: dataRes.rows,
            rowCount: Number(cellToString(rowCountRes.rows[0][0])),
          },
          structure: structureRes.rows.map((row: any) => ({
            column_name: cellToString(row[1]),
            data_type: cellToString(row[2]),
            is_nullable: cellToString(row[8]).toLowerCase() === "yes",
            check: cellToString(row[9]),
            column_default: cellToString(row[11]),
            foreign_key: cellToString(row[12]),
            comment: cellToString(row[13]),
          })),
          constraints: constraintsRes.rows.map((row: any) => ({
            index_name: cellToString(row[0]),
            index_algorithm: cellToString(row[1]),
            is_unique: cellToString(row[2]).toLowerCase() === "true",
            index_definition: cellToString(row[3]),
            column_name: cellToString(row[4]),
            condition: cellToString(row[5]),
            include: cellToString(row[6]),
            comment: cellToString(row[7]),
          })),
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
          constraints: null,
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
          constraints: null,
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
