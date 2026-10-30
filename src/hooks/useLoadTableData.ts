import { useCallback, useMemo, useRef } from "preact/hooks";
import { connectTabOnce, runtimeServesTab } from "src/lib/runtimeConnection";
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
import { sqlForDisplay } from "src/lib/sql/sqlDialect";
import type { DatabaseEngine } from "src/types";

export { tableKey, DEFAULT_LIMIT, DEFAULT_OFFSET } from "src/lib/table-data";
export type { LoadFlags, TablePagination } from "src/lib/table-data";

export function useLoadTableData() {
  const tableDataMap = useConnectionStore((s) => s.tableDataMap);
  const setMeta = useConnectionStore((s) => s.addTableDataMap);
  const removeMeta = useConnectionStore((s) => s.removeTableDataMap);

  const setColumnsCache = useConnectionStore((s) => s.setColumnsCache);
  const setSizeInfoCache = useConnectionStore((s) => s.setSizeInfoCache);
  const addQueryHistory = useConnectionStore((s) => s.addQueryHistory);

  const profileTabs = useScreenStore((s) => s.profileTabs);
  const activeProfileScreen = useScreenStore((s) => s.activeProfileScreen);

  /** Table key → the owner of its running load (see `owner` below). */
  const loadingKeysRef = useRef<Map<string, string>>(new Map());

  const activeTab = useMemo(() => {
    if (!activeProfileScreen || activeProfileScreen === "main") return null;
    return profileTabs.find((t) => t.id === activeProfileScreen) ?? null;
  }, [profileTabs, activeProfileScreen]);

  const addLogQuery = useCallback(
    (sql: string, engine?: DatabaseEngine) => {
      if (!activeTab) return;
      addQueryHistory(activeTab.id, sqlForDisplay(sql, engine));
    },
    [activeTab, addQueryHistory]
  );

  /** The tab's connection, acquired on what it was opened on (R1, R4). */
  const ensureRuntimeConn = useCallback(
    async (key: string) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");
      // The tab's own connection wins; a table's is used only when the tab
      // acquired it on the same target (R4). Read live, never a snapshot.
      const live = useScreenStore
        .getState()
        .profileTabs.find((t) => t.id === activeTab.id);
      if (live?.runtimeConnectionId) return live.runtimeConnectionId;
      const meta = useConnectionStore.getState().tableDataMap[key];
      if (
        meta?.connectionId &&
        runtimeServesTab(activeTab.id, meta.connectionId)
      ) {
        return meta.connectionId;
      }
      return await connectTabOnce(activeTab.id);
    },
    [activeTab]
  );

  const loadTableData = useCallback(
    async (
      schema: string,
      tableName: string,
      pagination?: TablePagination,
      flags: LoadFlags = {}
    ) => {
      if (!activeTab) throw new Error("NO_ACTIVE_TAB");
      const tabId = activeTab.id;

      const key = tableKey(activeProfileScreen, schema, tableName);
      // Loads are owned by the tab's connection and epoch at the time they
      // start (R5): a load after a reconnect, a profile save or a refusal
      // never joins (or waits for) one started before.
      const screen = useScreenStore.getState();
      const owner = JSON.stringify([
        screen.profileTabs.find((t) => t.id === tabId)?.runtimeConnectionId ??
          null,
        screen.tabEpoch[tabId] ?? 0,
      ]);
      const loadSignature = buildLoadSignature({ key, pagination, flags });
      const signatureSlot = `${loadSignature}\u0000${owner}`;
      const tableSlot = `${key}\u0000${owner}`;
      const existingLoad = inflightLoadBySignature.get(signatureSlot);
      if (existingLoad) {
        return existingLoad;
      }

      const existingTableLoad = inflightLoadByTableKey.get(tableSlot);
      // Do not coalesce meta/stats/force refreshes into an in-flight rows-only load —
      // that left Save Changes without constraints and forced Virtual-key WHERE.
      // forceRefresh must be included here AND in the loadingKeysRef guard below;
      // omitting it made MenuBar "refresh focused tab" race the pane loader.
      const bypassInflightGuard =
        !!flags.force ||
        !!flags.forceRefresh ||
        !!flags.forceRows ||
        !!flags.refreshMeta ||
        !!flags.refreshForeignKeys ||
        !!flags.refreshStats ||
        !!flags.refreshRowCount;

      if (existingTableLoad && !bypassInflightGuard) {
        return existingTableLoad;
      }

      const task = (async () => {
        latestLoadSignatureByKey.set(key, loadSignature);

        if (loadingKeysRef.current.get(key) === owner && !bypassInflightGuard) {
          return;
        }
        loadingKeysRef.current.set(key, owner);

        try {
          // 1) The connection first: what was loaded before it is decided
          //    must not shape this load (R4).
          let connId: string;
          try {
            connId = await ensureRuntimeConn(key);
          } catch (e) {
            if (
              useScreenStore.getState().profileTabs.some((t) => t.id === tabId)
            ) {
              patchMeta(setMeta, key, EMPTY_META, {
                busy: false,
                error: getErrorMessage(e),
              });
            }
            return;
          }
          const liveTab = useScreenStore
            .getState()
            .profileTabs.find((t) => t.id === tabId);
          // Closed, or moved to another connection, meanwhile: nothing to do.
          if (!liveTab) return;
          if (!liveTab.runtimeConnectionId) {
            useScreenStore
              .getState()
              .updateTab(tabId, { runtimeConnectionId: connId });
          } else if (liveTab.runtimeConnectionId !== connId) {
            return;
          }

          // What this load may still publish (R5): nothing once the tab's
          // connection changed or its epoch moved (profile saved again,
          // connection refused). Its own pending flag is still retired,
          // unless a newer load of the table owns it.
          const startEpoch = useScreenStore.getState().tabEpoch[tabId] ?? 0;
          const isCurrent = () => {
            const s = useScreenStore.getState();
            return (
              (s.tabEpoch[tabId] ?? 0) === startEpoch &&
              s.profileTabs.find((t) => t.id === tabId)?.runtimeConnectionId ===
                connId
            );
          };
          const retire = (k: string) => {
            if (latestLoadSignatureByKey.get(key) !== loadSignature) return;
            const cur = useConnectionStore.getState().tableDataMap[k];
            if (cur?.busy) setMeta(k, { ...cur, busy: false });
          };
          const guardedSetMeta: typeof setMeta = (k, data) => {
            if (isCurrent()) setMeta(k, data);
            else retire(k);
          };
          const guardedColumnsCache: typeof setColumnsCache = (k, cols) => {
            if (isCurrent()) setColumnsCache(k, cols);
          };
          const guardedSizeInfoCache: typeof setSizeInfoCache = (k, info) => {
            if (isCurrent()) setSizeInfoCache(k, info);
          };

          // 2) The table's state as it is now (after any invalidation the
          //    connection brought), never a snapshot from before.
          const live = useConnectionStore.getState();
          const prev = live.tableDataMap[key] ?? EMPTY_META;
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

          if (flags.metaOnly) {
            // Keep the data query's error: this load does not rerun it.
            patchMeta(guardedSetMeta, key, prev, { busy: true });
          } else if (plan.needAnyMetaWork) {
            patchMeta(guardedSetMeta, key, prev, { busy: true, error: null });
          } else if (!prev.error) {
            patchMeta(guardedSetMeta, key, prev, { error: null });
          }

          // The table follows the tab's connection (never keeps an older one).
          patchMeta(guardedSetMeta, key, prev, { connectionId: connId });

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
            databaseOverride:
              activeTab.target?.kind === "override"
                ? activeTab.target.database
                : null,
            supportsMeta: supportsTableMeta(activeTab.engine),
            columnsCache: live.columnsCache,
            sizeInfoCache: live.sizeInfoCache,
            isCurrent,
            owner,
            setMeta: guardedSetMeta,
            setColumnsCache: guardedColumnsCache,
            setSizeInfoCache: guardedSizeInfoCache,
            addLogQuery,
          });
        } finally {
          // Never clears the slot of a newer owner.
          if (loadingKeysRef.current.get(key) === owner) {
            loadingKeysRef.current.delete(key);
          }
        }
      })();

      inflightLoadBySignature.set(signatureSlot, task);
      inflightLoadByTableKey.set(tableSlot, task);
      try {
        await task;
      } finally {
        if (inflightLoadBySignature.get(signatureSlot) === task) {
          inflightLoadBySignature.delete(signatureSlot);
        }
        if (inflightLoadByTableKey.get(tableSlot) === task) {
          inflightLoadByTableKey.delete(tableSlot);
        }
      }
    },
    [
      activeTab,
      activeProfileScreen,
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
      useConnectionStore.getState().clearTableFilter(key, false);
      useConnectionStore.getState().clearTableSort(key);

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
