import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { cellToString } from "src/utils/convert";
import { DATA_ACTIONS, DATA_KEYS } from "src/constant";
import type { ConnectionState, DataPatchesState } from "./types";
import {
  cacheGet,
  getPrimaryKeyColumnsFromConstraints,
  normalizePrimaryKeyValue,
} from "./rowCache";
import { createRowsUiActions } from "./rowsSlice";

export const useConnectionStore = create<ConnectionState>()(
  subscribeWithSelector((set, get) => {
    // -------------------------------------------------------------------------
    // Batched notify: at most 1 state update per frame per table key
    // -------------------------------------------------------------------------
    type PendingMeta = { loadedMax: number; lastChunkAt: number };

    const pendingMeta = new Map<string, PendingMeta>();
    const rafByKey = new Map<string, number>();

    function scheduleRowsNotify(key: string, opts?: { immediate?: boolean }) {
      const immediate = !!opts?.immediate;

      const flush = () => {
        rafByKey.delete(key);

        const meta = pendingMeta.get(key);
        if (!meta) return;
        pendingMeta.delete(key);

        useConnectionStore.setState((s) => {
          const prev = s.tableRowsByKey[key];
          if (!prev) return s;

          // ✅ IMPORTANT: bump version so UI knows data changed
          const next = {
            ...prev,
            loadedMax: Math.max(prev.loadedMax ?? -1, meta.loadedMax),
            lastChunkAt: meta.lastChunkAt,
            version: (prev.version ?? 0) + 1,
          };

          return {
            tableRowsByKey: { ...s.tableRowsByKey, [key]: next },
          };
        });
      };

      if (immediate) {
        // Cancel any pending RAF so we flush immediately
        const raf = rafByKey.get(key);
        if (raf) {
          cancelAnimationFrame(raf);
          rafByKey.delete(key);
        }
        flush();
        return;
      }

      if (rafByKey.has(key)) return;

      const raf = requestAnimationFrame(() => flush());
      rafByKey.set(key, raf);
    }

    function dataPatchMapWithWindowPatches(
      s: ConnectionState,
      tabId: string,
      tableWindowId: string,
      windowData: NonNullable<ConnectionState["dataPatchMap"][string]>[string],
      patches: NonNullable<
        ConnectionState["dataPatchMap"][string]
      >[string]["patches"]
    ) {
      if (Object.keys(patches).length > 0) {
        return {
          ...s.dataPatchMap,
          [tabId]: {
            ...(s.dataPatchMap[tabId] ?? {}),
            [tableWindowId]: {
              ...windowData,
              patches,
            },
          },
        };
      }

      const tabPatchMap = s.dataPatchMap[tabId] ?? {};
      const { [tableWindowId]: _, ...restWindows } = tabPatchMap;
      if (Object.keys(restWindows).length === 0) {
        const { [tabId]: _, ...restTabs } = s.dataPatchMap;
        return restTabs;
      }
      return {
        ...s.dataPatchMap,
        [tabId]: restWindows,
      };
    }

    return {
      tables: {},
      schemas: {},
      tableDataMap: {},

      sqlResults: {},
      queryHistory: {},

      columnsCache: {},
      sizeInfoCache: {},

      tableStructure: {},
      tableConstraints: {},
      dataPatchMap: {},
      virtualKeySafetyByKey: {},
      newTableData: {},

      tableFilterByKey: {},
      tableSortByKey: {},

      tableRowsByKey: {},
      tableRowCacheByKey: {},
      selectedRowByKey: {},
      rowFieldEditHandlerByKey: {},

      /* =========================================================================
       * Existing actions (keep as your current implementation)
       * ========================================================================= */

      setSqlResult: (windowId, patch) =>
        set((s) => {
          const prev = s.sqlResults[windowId] ?? {
            busy: false,
            error: null,
            result: null,
          };

          const next = { ...prev, ...patch };

          if (
            prev.busy === next.busy &&
            prev.error === next.error &&
            prev.result === next.result &&
            prev.lastRunAt === next.lastRunAt
          ) {
            return s;
          }

          return {
            sqlResults: {
              ...s.sqlResults,
              [windowId]: next,
            },
          };
        }),

      clearSqlResult: (windowId) =>
        set((s) => {
          if (!s.sqlResults[windowId]) return s;
          const { [windowId]: _, ...rest } = s.sqlResults;
          return { sqlResults: rest };
        }),

      setSchemas: (windowId, data) =>
        set((s) => ({
          schemas: {
            ...s.schemas,
            [windowId]: data,
          },
        })),

      addSchema: (windowId, schema) =>
        set((s) => ({
          schemas: {
            ...s.schemas,
            [windowId]: {
              ...(s.schemas[windowId] || {
                data: [],
                busy: false,
                error: null,
              }),
              data: [...(s.schemas[windowId]?.data || []), schema],
            },
          },
        })),

      setTables: (windowId, data) =>
        set((s) => ({
          tables: {
            ...s.tables,
            [windowId]: data,
          },
        })),

      addTable: (windowId, table) =>
        set((s) => ({
          tables: {
            ...s.tables,
            [windowId]: {
              ...(s.tables[windowId] || { data: [], busy: false, error: null }),
              data: [...(s.tables[windowId]?.data || []), table],
            },
          },
        })),

      addTableDataMap: (windowId, tableData) =>
        set((s) => ({
          tableDataMap: {
            ...s.tableDataMap,
            [windowId]: tableData,
          },
        })),

      removeTableDataMap: (windowId) =>
        set((s) => {
          const { [windowId]: _, ...rest } = s.tableDataMap;
          return { tableDataMap: rest };
        }),

      setColumnsCache: (key, cols) =>
        set((s) => ({ columnsCache: { ...s.columnsCache, [key]: cols } })),

      setSizeInfoCache: (key, info) =>
        set((s) => ({ sizeInfoCache: { ...s.sizeInfoCache, [key]: info } })),

      addQueryHistory: (windowId, sql) =>
        set((s) => ({
          queryHistory: {
            ...s.queryHistory,
            [windowId]: [
              ...(s.queryHistory[windowId] || []),
              { sql, timestamp: new Date() },
            ],
          },
        })),

      clearQueryHistory: (windowId) =>
        set((s) => ({
          queryHistory: {
            ...s.queryHistory,
            [windowId]: [],
          },
        })),

      setTableSort: (key, sort) =>
        set((s) => {
          if (!sort) {
            if (!s.tableSortByKey[key]) return s;
            const { [key]: _, ...rest } = s.tableSortByKey;
            return { tableSortByKey: rest };
          }

          const previous = s.tableSortByKey[key];
          if (
            previous?.colName === sort.colName &&
            previous.direction === sort.direction
          ) {
            return s;
          }

          return {
            tableSortByKey: {
              ...s.tableSortByKey,
              [key]: sort,
            },
          };
        }),

      clearTableSort: (key) =>
        set((s) => {
          if (!s.tableSortByKey[key]) return s;
          const { [key]: _, ...rest } = s.tableSortByKey;
          return { tableSortByKey: rest };
        }),

      setTableStructure: (tabId, tableWindowId, structure) =>
        set((s) => ({
          tableStructure: {
            ...s.tableStructure,
            [tabId]: {
              ...s.tableStructure[tabId],
              [tableWindowId]: structure,
            },
          },
        })),

      updateTableStructure: (tabId, tableWindowId, rowIndex, field, value) =>
        set((s) => {
          const structure = s.tableStructure[tabId]?.[tableWindowId] ?? [];
          const newStructure = [...structure];
          newStructure[rowIndex] = {
            ...newStructure[rowIndex]!,
            [field]: value,
          };
          return {
            tableStructure: {
              ...s.tableStructure,
              [tabId]: {
                ...s.tableStructure[tabId],
                [tableWindowId]: newStructure,
              },
            },
          };
        }),

      setTableConstraints: (tabId, tableWindowId, constraints) =>
        set((s) => ({
          tableConstraints: {
            ...s.tableConstraints,
            [tabId]: {
              ...s.tableConstraints[tabId],
              [tableWindowId]: constraints,
            },
          },
        })),

      updateTableConstraints: (tabId, tableWindowId, rowIndex, field, value) =>
        set((s) => {
          const constraints = s.tableConstraints[tabId]?.[tableWindowId] ?? [];
          const newConstraints = [...constraints];
          newConstraints[rowIndex] = {
            ...newConstraints[rowIndex]!,
            [field]: value,
          };
          return {
            tableConstraints: {
              ...s.tableConstraints,
              [tabId]: {
                ...s.tableConstraints[tabId],
                [tableWindowId]: newConstraints,
              },
            },
          };
        }),

      clearTableStructure: (tabId, tableWindowId) =>
        set((s) => {
          if (!s.tableStructure[tabId]) return s;

          if (tableWindowId) {
            const { [tableWindowId]: _, ...rest } = s.tableStructure[tabId];
            return { tableStructure: { ...s.tableStructure, [tabId]: rest } };
          }

          return { tableStructure: { ...s.tableStructure, [tabId]: {} } };
        }),

      clearTableConstraints: (tabId, tableWindowId) =>
        set((s) => {
          if (!s.tableConstraints[tabId]) return s;

          if (tableWindowId) {
            const { [tableWindowId]: _, ...rest } = s.tableConstraints[tabId];
            return {
              tableConstraints: { ...s.tableConstraints, [tabId]: rest },
            };
          }

          return { tableConstraints: { ...s.tableConstraints, [tabId]: {} } };
        }),

      setDataPatchMap: (tabId: string, props: DataPatchesState) => {
        const { dataKey, action, tableData, tableWindow, rowKey, data } = props;
        const tableWindowId = tableWindow.id;

        set((s) => {
          const existingRowPatch =
            s.dataPatchMap[tabId]?.[tableWindowId]?.patches?.[action]?.[
              dataKey
            ]?.[rowKey];

          let dataToWrite: Record<string, any> = {
            ...(existingRowPatch ?? {}),
            ...data,
          };

          // If changed value equals original, remove that key from the patch
          if (action === DATA_ACTIONS.update) {
            const tableKey = `${tabId}.${tableWindow.table.schema}.${tableWindow.table.name}`;
            let original: Record<string, any> | undefined;

            if (dataKey === DATA_KEYS.data) {
              const localRowIndex = parseInt(rowKey, 10);
              if (!isNaN(localRowIndex) && localRowIndex >= 0) {
                const rowsState = s.tableRowsByKey[tableKey];
                const globalRowIndex =
                  (rowsState?.streamOffset ?? 0) + localRowIndex;
                const cache = s.tableRowCacheByKey[tableKey];
                let originalRow = cacheGet(cache, globalRowIndex) as
                  | unknown[]
                  | undefined;
                if (
                  !originalRow &&
                  rowsState &&
                  globalRowIndex >= rowsState.base &&
                  globalRowIndex < rowsState.base + rowsState.cap
                ) {
                  originalRow = rowsState.rows[
                    globalRowIndex - rowsState.base
                  ] as unknown[] | undefined;
                }
                const columns = tableData.columns ?? [];
                if (
                  originalRow &&
                  Array.isArray(originalRow) &&
                  columns.length
                ) {
                  original = {};
                  for (let i = 0; i < columns.length; i++) {
                    const col = columns[i];
                    if (col?.name) original[col.name] = originalRow[i];
                  }
                }
              }
            } else if (dataKey === DATA_KEYS.structure) {
              const rowIndex = parseInt(rowKey, 10);
              if (!isNaN(rowIndex) && rowIndex >= 0) {
                const meta = s.tableDataMap[tableKey];
                const structure = meta?.structure;
                original = structure?.[rowIndex] as
                  | Record<string, any>
                  | undefined;
              } else if (rowKey === "-1") {
                const meta = s.tableDataMap[tableKey];
                original = {
                  tableName: tableWindow.table.name,
                  primaryKey: getPrimaryKeyColumnsFromConstraints(
                    meta?.constraints
                  ),
                };
              }
            } else if (dataKey === DATA_KEYS.constraints) {
              const rowIndex = parseInt(rowKey, 10);
              if (!isNaN(rowIndex) && rowIndex >= 0) {
                const meta = s.tableDataMap[tableKey];
                const constraints = meta?.constraints;
                original = constraints?.[rowIndex] as
                  | Record<string, any>
                  | undefined;
              }
            }

            if (original) {
              const cleaned: Record<string, any> = {};
              for (const [key, value] of Object.entries(dataToWrite)) {
                if (key === "__rowKey") {
                  cleaned[key] = value;
                  continue;
                }
                if (key === "primaryKey") {
                  const patchPk = normalizePrimaryKeyValue(value);
                  const origPk = normalizePrimaryKeyValue(original[key]);
                  const samePk =
                    patchPk.length === origPk.length &&
                    patchPk.every((col, index) => col === origPk[index]);
                  if (!samePk) cleaned[key] = patchPk;
                  continue;
                }
                let origVal = original[key];
                if (dataKey === DATA_KEYS.structure && key === "foreign_key") {
                  const rowColumn =
                    typeof original.column_name === "string"
                      ? original.column_name.trim()
                      : "";
                  if ((cellToString(origVal) ?? "") === "" && rowColumn) {
                    const meta = s.tableDataMap[tableKey];
                    const existingFk =
                      meta?.foreignKeys?.find((fk) =>
                        fk.column_names
                          .split(",")
                          .map((x) => x.trim())
                          .includes(rowColumn)
                      ) ?? null;
                    if (
                      existingFk?.ref_table_name &&
                      existingFk?.ref_column_names
                    ) {
                      origVal = `${existingFk.ref_table_name}(${existingFk.ref_column_names})`;
                    }
                  }
                }
                const patchStr = cellToString(value);
                const origStr = cellToString(origVal);
                if (patchStr !== origStr) cleaned[key] = value;
              }
              dataToWrite = cleaned;
            }
          }

          const windowData = s.dataPatchMap[tabId]?.[tableWindowId];
          const patches = windowData?.patches ?? {};
          const actionPatches = patches[action] ?? {};
          const dataKeyPatches = actionPatches[dataKey] ?? {};

          // If no keys left to write, remove this row from the patch.
          // NOTE: For `delete` actions we still need an entry (the key itself
          // is the information), so we only prune empty data for non-delete
          // actions (primarily `update`).
          if (
            action !== DATA_ACTIONS.delete &&
            Object.keys(dataToWrite).length === 0
          ) {
            if (!windowData?.patches?.[action]?.[dataKey]?.[rowKey]) return s;
            const nextPatches = { ...patches };
            const nextAction = { ...actionPatches };
            const nextDataKey = { ...dataKeyPatches };
            delete nextDataKey[rowKey];
            if (Object.keys(nextDataKey).length === 0) {
              delete nextAction[dataKey];
              if (Object.keys(nextAction).length === 0)
                delete nextPatches[action];
              else nextPatches[action] = nextAction;
            } else
              nextPatches[action] = { ...nextAction, [dataKey]: nextDataKey };
            const cleanedPatches =
              Object.keys(nextPatches).length > 0 ? nextPatches : {};
            return {
              dataPatchMap: dataPatchMapWithWindowPatches(
                s,
                tabId,
                tableWindowId,
                windowData!,
                cleanedPatches
              ),
            };
          }

          return {
            dataPatchMap: {
              ...s.dataPatchMap,
              [tabId]: {
                ...(s.dataPatchMap[tabId] ?? {}),
                [tableWindowId]: {
                  tableData,
                  tableWindow,
                  patches: {
                    ...patches,
                    [action]: {
                      ...actionPatches,
                      [dataKey]: {
                        ...dataKeyPatches,
                        [rowKey]: dataToWrite,
                      },
                    },
                  },
                },
              },
            },
          };
        });
      },

      removeDataPatch: (tabId, tableWindowId, action, dataKey, rowKey) =>
        set((s) => {
          const windowData = s.dataPatchMap[tabId]?.[tableWindowId];
          if (!windowData?.patches?.[action]?.[dataKey]?.[rowKey]) return s;

          const patches = { ...windowData.patches };
          const actionPatches = { ...patches[action] };
          const dataKeyPatches = { ...actionPatches[dataKey] };
          const { [rowKey]: _, ...restDataKeyPatches } = dataKeyPatches;

          let finalPatches: typeof patches;

          if (Object.keys(restDataKeyPatches).length === 0) {
            const { [dataKey]: _, ...restActionPatches } = actionPatches;
            if (Object.keys(restActionPatches).length === 0) {
              const { [action]: _, ...restPatches } = patches;
              finalPatches = restPatches;
            } else {
              finalPatches = { ...patches, [action]: restActionPatches };
            }
          } else {
            actionPatches[dataKey] = restDataKeyPatches;
            finalPatches = { ...patches, [action]: actionPatches };
          }

          const cleanedPatches =
            Object.keys(finalPatches).length > 0 ? finalPatches : {};

          return {
            dataPatchMap: dataPatchMapWithWindowPatches(
              s,
              tabId,
              tableWindowId,
              windowData,
              cleanedPatches
            ),
          };
        }),

      clearDataPatchMap: (tabId, tableWindowId) =>
        set((s) => {
          if (!s.dataPatchMap[tabId]) return s;

          if (tableWindowId) {
            const { [tableWindowId]: _, ...rest } = s.dataPatchMap[tabId];
            return { dataPatchMap: { ...s.dataPatchMap, [tabId]: rest } };
          }

          const { [tabId]: _, ...rest } = s.dataPatchMap;
          return { dataPatchMap: rest };
        }),

      setVirtualKeySafety: (key, issues) =>
        set((s) => ({
          virtualKeySafetyByKey: {
            ...s.virtualKeySafetyByKey,
            [key]: issues,
          },
        })),

      clearVirtualKeySafety: (key) =>
        set((s) => {
          if (!s.virtualKeySafetyByKey[key]) return s;
          const { [key]: _, ...rest } = s.virtualKeySafetyByKey;
          return { virtualKeySafetyByKey: rest };
        }),

      setNewTableData: (tabId, tableWindowId, data) =>
        set((s) => ({
          newTableData: {
            ...s.newTableData,
            [tabId]: {
              ...s.newTableData[tabId],
              [tableWindowId]: data,
            },
          },
        })),

      clearNewTableData: (tabId, tableWindowId) =>
        set((s) => {
          if (!s.newTableData[tabId]) return s;

          if (tableWindowId) {
            const { [tableWindowId]: _, ...rest } = s.newTableData[tabId];
            return { newTableData: { ...s.newTableData, [tabId]: rest } };
          }

          return { newTableData: { ...s.newTableData, [tabId]: {} } };
        }),

      /* ===========================================================================
       * Rows API (batched notify)
       * =========================================================================== */

      ...createRowsUiActions({ set, get, pendingMeta, scheduleRowsNotify }),
    };
  })
);
