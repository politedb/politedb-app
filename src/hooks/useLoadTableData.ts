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

export type TablePagination = { limit: number; offset: number };

const EMPTY = {
  data: null,
  structure: null,
  constraints: null,
  sizeInfo: null,
  connectionId: null,
  busy: false,
  error: null,
};

export type LoadFlags = {
  force?: boolean; // force refresh everything relevant
  refreshRows?: boolean; // default true (but first-load always fetches rows)
  refreshMeta?: boolean; // structure + constraints (default false)
  refreshStats?: boolean; // rowCount + sizeInfo (default false)
};

type ColumnRow = { name: string; db_type: string };

function isNonEmptyName(v: ColumnRow) {
  return (v.name ?? "").trim().length > 0;
}

function getErrorMessage(e: unknown) {
  if (e && typeof e === "object") {
    const rec = e as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error) return rec.error;
    if (typeof rec.message === "string" && rec.message) return rec.message;
  }
  return String(e ?? "UNKNOWN_ERROR");
}

export function useLoadTableData() {
  const tableDataMap = useConnectionStore((s) => s.tableDataMap);
  const addTableDataMap = useConnectionStore((s) => s.addTableDataMap);
  const removeTableDataMap = useConnectionStore((s) => s.removeTableDataMap);
  const addQueryHistory = useConnectionStore((s) => s.addQueryHistory);

  const profileTabs = useScreenStore((s) => s.profileTabs);
  const activeProfileScreen = useScreenStore((s) => s.activeProfileScreen);

  const activeTab = useMemo(() => {
    if (!activeProfileScreen || activeProfileScreen === "main") return null;
    return profileTabs.find((t) => t.id === activeProfileScreen) ?? null;
  }, [profileTabs, activeProfileScreen]);

  const addLogQuery = useCallback(
    (sql: string) => {
      if (!activeTab) return;
      addQueryHistory(activeTab.id, sql);
    },
    [activeTab, addQueryHistory]
  );

  const ensureRuntimeConn = useCallback(
    async (key: string) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");

      const tableData = tableDataMap[key];
      if (tableData?.connectionId) return tableData.connectionId;

      const res = await profileConnect(activeTab.profileId);
      return res.connection.id;
    },
    [activeTab, tableDataMap]
  );

  /**
   * loadTableData:
   * - First load: ALWAYS fetch minimum (columns + rows) even if flags say otherwise.
   * - Subsequent loads: respect flags.
   */
  const loadTableData = useCallback(
    async (
      schema: string,
      tableName: string,
      pagination?: TablePagination,
      flags: LoadFlags = {}
    ) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");

      const key = tableKey(activeProfileScreen, schema, tableName);
      const prev = tableDataMap[key] ?? EMPTY;

      const force = !!flags.force;

      const refreshRows = flags.refreshRows ?? true;
      const refreshMeta = flags.refreshMeta ?? false;
      const refreshStats = flags.refreshStats ?? false;

      const hasColumns = !!prev.data?.columns?.length;
      const hasRows = Array.isArray(prev.data?.rows);

      const hasRowCount =
        typeof prev.data?.rowCount === "number" && prev.data.rowCount >= 0;
      const hasSizeInfo = !!prev.sizeInfo;

      const hasStructure =
        Array.isArray(prev.structure) && prev.structure.length > 0;
      const hasConstraints =
        Array.isArray(prev.constraints) && prev.constraints.length > 0;

      const isFirstLoad = !hasColumns || !hasRows;

      // ✅ first load must fetch minimum dataset (columns + rows)
      const needColumns = force || isFirstLoad || !hasColumns;
      const needRows = force || isFirstLoad || refreshRows;

      // ✅ only fetch stats/meta on first load if you explicitly want (force) — default OFF
      const needRowCount =
        (force ? true : !isFirstLoad && refreshStats) &&
        (force || !hasRowCount);
      const needSizeInfo =
        (force ? true : !isFirstLoad && refreshStats) &&
        (force || !hasSizeInfo);
      const needMeta =
        (force ? true : !isFirstLoad && refreshMeta) &&
        (force || !hasStructure || !hasConstraints);

      // if absolutely nothing to do, return
      if (
        !needColumns &&
        !needRows &&
        !needRowCount &&
        !needSizeInfo &&
        !needMeta
      ) {
        return;
      }

      // mark busy but KEEP existing data (avoid flicker)
      addTableDataMap(key, { ...prev, busy: true, error: null });

      try {
        const connId = await ensureRuntimeConn(key);

        // ===== Columns
        let columns = prev.data?.columns ?? [];
        if (needColumns) {
          const q = tableColumnsQuery(schema, tableName);
          const res = await runSqlQuery(connId, q);
          addLogQuery(q);

          columns = (res.rows as unknown[][])
            .map((r) => ({
              name: cellToString(r?.[0]),
              db_type: cellToString(r?.[1]),
            }))
            .filter(isNonEmptyName);
        }

        // ===== Rows
        let rows = prev.data?.rows ?? [];
        if (needRows) {
          const q = tableDataQuery(schema, tableName, pagination);
          const res = await runSqlQuery(connId, q);
          addLogQuery(q);
          rows = res.rows as unknown[][];
        }

        // ===== Stats
        let rowCount = prev.data?.rowCount ?? 0;
        if (needRowCount) {
          const q = tableRowCountQuery(schema, tableName);
          const res = await runSqlQuery(connId, q);
          addLogQuery(q);
          rowCount = Number(cellToString((res.rows as unknown[][])?.[0]?.[0]));
        }

        let sizeInfo = prev.sizeInfo;
        if (needSizeInfo) {
          const q = tableSizeInfoQuery(schema, tableName);
          const res = await runSqlQuery(connId, q);
          addLogQuery(q);

          const r0 = (res.rows as unknown[][])?.[0] ?? [];
          sizeInfo = {
            totalSize: cellToString(r0?.[0]),
            dataSize: cellToString(r0?.[1]),
            indexSize: cellToString(r0?.[2]),
          };
        }

        // ===== Meta: oid + structure + constraints
        let structure = prev.structure;
        let constraints = prev.constraints;

        if (needMeta) {
          const qOid = tableOidQuery(schema, tableName);
          const oidRes = await runSqlQuery(connId, qOid);
          addLogQuery(qOid);

          const oid = Number(
            cellToString((oidRes.rows as unknown[][])?.[0]?.[0])
          );

          const qStructure = tableStructuresQuery(schema, tableName, oid);
          const structureRes = await runSqlQuery(connId, qStructure);
          addLogQuery(qStructure);

          structure = (structureRes.rows as unknown[][]).map((row) => ({
            column_name: cellToString(row?.[1]),
            data_type: cellToString(row?.[2]),
            is_nullable: cellToString(row?.[8]).toLowerCase() === "yes",
            check: cellToString(row?.[9]),
            column_default: cellToString(row?.[11]),
            foreign_key: cellToString(row?.[12]),
            comment: cellToString(row?.[13]),
          }));

          const qConstraints = tableConstraintsQuery(schema, tableName);
          const constraintsRes = await runSqlQuery(connId, qConstraints);
          addLogQuery(qConstraints);

          constraints = (constraintsRes.rows as unknown[][]).map((row) => ({
            index_name: cellToString(row?.[0]),
            index_algorithm: cellToString(row?.[1]),
            is_unique: cellToString(row?.[2]).toLowerCase() === "true",
            index_definition: cellToString(row?.[3]),
            column_name: cellToString(row?.[4]),
            condition: cellToString(row?.[5]),
            include: cellToString(row?.[6]),
            comment: cellToString(row?.[7]),
          }));
        }

        addTableDataMap(key, {
          ...prev,
          data: {
            columns,
            rows,
            rowCount,
          },
          structure,
          constraints,
          sizeInfo,
          connectionId: prev.connectionId ?? connId,
          busy: false,
          error: null,
        });
      } catch (e: unknown) {
        addTableDataMap(key, {
          ...prev,
          busy: false,
          error: getErrorMessage(e),
        });
      }
    },
    [
      activeTab,
      activeProfileScreen,
      tableDataMap,
      addTableDataMap,
      ensureRuntimeConn,
      addLogQuery,
    ]
  );

  const getTableData = useCallback(
    (activeScreen: string, schema: string, tableName: string) => {
      const key = tableKey(activeScreen, schema, tableName);
      return tableDataMap[key] ?? EMPTY;
    },
    [tableDataMap]
  );

  const removeTableData = useCallback(
    (schema: string, tableName: string) => {
      const key = tableKey(activeProfileScreen, schema, tableName);
      removeTableDataMap(key);
    },
    [activeProfileScreen, removeTableDataMap]
  );

  return {
    loadTableData,
    getTableData,
    removeTableData,
  };
}
