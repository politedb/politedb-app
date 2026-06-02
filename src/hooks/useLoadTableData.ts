import { useCallback, useMemo, useRef } from "preact/hooks";
import { connectProfileOnce } from "src/lib/runtimeConnection";
import { operationCancel } from "src/lib/tauri";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import {
  buildLoadSignature,
  computeLoadPlan,
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  EMPTY_META,
  executeEngineLoad,
  shouldDoAnything,
  supportsTableMeta,
  tableKey,
} from "src/lib/table-data";
import {
  inflightLoadBySignature,
  inflightLoadByTableKey,
  latestLoadSignatureByKey,
} from "src/lib/table-data/inflight";
import { getErrorMessage } from "src/lib/table-data/helpers";
import { patchMeta } from "src/lib/table-data/metaPatch";
import type { LoadFlags, TablePagination } from "src/lib/table-data";

export {
  tableKey,
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
} from "src/lib/table-data";
export type { LoadFlags, TablePagination } from "src/lib/table-data";

export function useLoadTableData() {
  const tableDataMap = useConnectionStore((s) => s.tableDataMap);
  const setMeta = useConnectionStore((s) => s.addTableDataMap);
  const removeMeta = useConnectionStore((s) => s.removeTableDataMap);

  const setColumnsCache = useConnectionStore((s) => s.setColumnsCache);
  const setSizeInfoCache = useConnectionStore((s) => s.setSizeInfoCache);
  const addQueryHistory = useConnectionStore((s) => s.addQueryHistory);

  const columnsCache = useConnectionStore((s) => s.columnsCache);
  const sizeInfoCache = useConnectionStore((s) => s.sizeInfoCache);

  const profileTabs = useScreenStore((s) => s.profileTabs);
  const activeProfileScreen = useScreenStore((s) => s.activeProfileScreen);

  const loadingKeysRef = useRef<Set<string>>(new Set());

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
      const meta = tableDataMap[key];
      if (meta?.connectionId) return meta.connectionId;
      if (activeTab.runtimeConnectionId) return activeTab.runtimeConnectionId;
      return await connectProfileOnce(activeTab.profileId);
    },
    [activeTab, tableDataMap]
  );

  const loadTableData = useCallback(
    async (
      schema: string,
      tableName: string,
      pagination?: TablePagination,
      flags: LoadFlags = {}
    ) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");

      const key = tableKey(activeProfileScreen, schema, tableName);
      const loadSignature = buildLoadSignature({ key, pagination, flags });
      const existingLoad = inflightLoadBySignature.get(loadSignature);
      if (existingLoad) {
        return existingLoad;
      }

      const existingTableLoad = inflightLoadByTableKey.get(key);
      if (
        existingTableLoad &&
        !flags.force &&
        !flags.forceRefresh &&
        !flags.forceRows
      ) {
        return existingTableLoad;
      }

      const task = (async () => {
        latestLoadSignatureByKey.set(key, loadSignature);

        if (
          loadingKeysRef.current.has(key) &&
          !flags.force &&
          !flags.forceRows
        ) {
          return;
        }
        loadingKeysRef.current.add(key);

        try {
          const prev = tableDataMap[key] ?? EMPTY_META;
          const plan = computeLoadPlan({
            key,
            prev,
            engine: activeTab.engine,
            flags,
            pagination,
          });

          if (!shouldDoAnything(plan)) return;

          const limit = pagination?.limit ?? DEFAULT_LIMIT;
          const offset = pagination?.offset ?? DEFAULT_OFFSET;

          if (plan.needAnyMetaWork) {
            patchMeta(setMeta, key, prev, { busy: true, error: null });
          } else if (!prev.error) {
            patchMeta(setMeta, key, prev, { error: null });
          }

          let connId: string;
          try {
            connId = activeTab.runtimeConnectionId
              ? activeTab.runtimeConnectionId
              : await ensureRuntimeConn(key);
          } catch (e) {
            patchMeta(setMeta, key, prev, {
              busy: false,
              error: getErrorMessage(e),
            });
            return;
          }

          patchMeta(setMeta, key, prev, {
            connectionId: prev.connectionId ?? connId,
          });

          if (!activeTab.runtimeConnectionId) {
            useScreenStore
              .getState()
              .updateTab(activeTab.id, { runtimeConnectionId: connId });
          }

          await executeEngineLoad({
            key,
            loadSignature,
            schema,
            tableName,
            connId,
            plan,
            prev,
            flags,
            limit,
            offset,
            engine: activeTab.engine,
            profileId: activeTab.profileId,
            supportsMeta: supportsTableMeta(activeTab.engine),
            columnsCache,
            sizeInfoCache,
            setMeta,
            setColumnsCache,
            setSizeInfoCache,
            addLogQuery,
          });
        } finally {
          loadingKeysRef.current.delete(key);
        }
      })();

      inflightLoadBySignature.set(loadSignature, task);
      inflightLoadByTableKey.set(key, task);
      try {
        await task;
      } finally {
        const current = inflightLoadBySignature.get(loadSignature);
        if (current === task) {
          inflightLoadBySignature.delete(loadSignature);
        }
        if (inflightLoadByTableKey.get(key) === task) {
          inflightLoadByTableKey.delete(key);
        }
      }
    },
    [
      activeTab,
      activeProfileScreen,
      tableDataMap,
      columnsCache,
      sizeInfoCache,
      setMeta,
      ensureRuntimeConn,
      addLogQuery,
      setColumnsCache,
      setSizeInfoCache,
    ]
  );

  const getTableData = useCallback(
    (activeScreen: string, schema: string, tableName: string) => {
      const key = tableKey(activeScreen, schema, tableName);
      return tableDataMap[key] ?? EMPTY_META;
    },
    [tableDataMap]
  );

  const removeTableData = useCallback(
    (schema: string, tableName: string) => {
      const key = tableKey(activeProfileScreen, schema, tableName);

      const rowsInfo = useConnectionStore.getState().getRowsWindowInfo(key);
      if (rowsInfo?.opId) {
        operationCancel(rowsInfo.opId).catch(() => {});
      }
      useConnectionStore.getState().clearRows(key);

      removeMeta(key);
    },
    [activeProfileScreen, removeMeta]
  );

  return {
    loadTableData,
    getTableData,
    removeTableData,
  };
}
