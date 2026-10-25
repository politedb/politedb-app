import {
  isPatchMetaKey,
  patchFieldEntries,
  recordedRow,
  withoutRowPositionPatches,
} from "src/lib/patches/rowPositionPatches";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { cellEditValuesEqual, cellToString } from "src/utils/convert";
import { findFkForColumn } from "src/utils/foreignKey";
import { DATA_ACTIONS, DATA_KEYS } from "src/constant";
import type { ConnectionState, DataPatchesState } from "./types";
import {
  cacheGet,
  getPrimaryKeyColumnsFromConstraints,
  normalizePrimaryKeyValue,
} from "./rowCache";
import { createRowsUiActions } from "./rowsSlice";
import { parseNullable } from "src/lib/sql/columnFlags";
import { tableRenameTarget } from "src/lib/sql/tableRename";

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

    /** The loaded row at a page-local position, from the original-row cache first. */
    function loadedOriginalRow(
      s: ConnectionState,
      tableKey: string,
      rowKey: string
    ): { row: unknown[]; fromCache: boolean } | undefined {
      const localRowIndex = parseInt(rowKey, 10);
      if (isNaN(localRowIndex) || localRowIndex < 0) return undefined;
      const rowsState = s.tableRowsByKey[tableKey];
      const globalRowIndex = (rowsState?.streamOffset ?? 0) + localRowIndex;
      const cached = cacheGet(s.tableRowCacheByKey[tableKey], globalRowIndex);
      if (Array.isArray(cached)) return { row: cached, fromCache: true };
      if (
        rowsState &&
        globalRowIndex >= rowsState.base &&
        globalRowIndex < rowsState.base + rowsState.cap
      ) {
        const row = rowsState.rows[globalRowIndex - rowsState.base];
        if (Array.isArray(row)) return { row, fromCache: false };
      }
      return undefined;
    }

    /** Whether two loaded rows are the same row as loaded (same values). */
    function sameLoadedRow(a: unknown[], b: unknown[]) {
      if (a === b) return true;
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }

    /**
     * Keeps a window's recorded row for `rowKey` while it has a row edit or delete
     * there, and drops it once neither remains.
     */
    function withRecordedRow<T extends Pick<ConnectionState, "dataPatchMap">>(
      next: T,
      tabId: string,
      tableWindowId: string,
      rowKey: string,
      row: unknown[] | undefined
    ): T {
      const win = next.dataPatchMap[tabId]?.[tableWindowId];
      if (!win) return next;
      const pending =
        !!win.patches?.update?.data?.[rowKey] ||
        !!win.patches?.delete?.data?.[rowKey];
      const { [rowKey]: _previous, ...rest } = win.originalRows ?? {};
      const originalRows = pending && row ? { ...rest, [rowKey]: row } : rest;
      return {
        ...next,
        dataPatchMap: {
          ...next.dataPatchMap,
          [tabId]: {
            ...next.dataPatchMap[tabId],
            [tableWindowId]: { ...win, originalRows },
          },
        },
      };
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

      addQueryHistory: (windowId, sql, options) =>
        set((s) => ({
          queryHistory: {
            ...s.queryHistory,
            [windowId]: [
              ...(s.queryHistory[windowId] || []),
              options?.kind
                ? { sql, timestamp: new Date(), kind: options.kind }
                : { sql, timestamp: new Date() },
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

      removeNewStructureRow: (tabId, tableWindowId, rowIndex) =>
        set((s) => {
          const rows = s.tableStructure[tabId]?.[tableWindowId];
          if (
            !rows ||
            !Number.isInteger(rowIndex) ||
            rowIndex < 0 ||
            rowIndex >= rows.length
          )
            return s;
          const windowData = s.dataPatchMap[tabId]?.[tableWindowId];
          const patches = { ...windowData?.patches };
          // Splicing a draft shifts the positional keys of all later draft patches.
          for (const action of ["create", "update", "delete"] as const) {
            const byAction = patches[action];
            if (!byAction?.structure) continue;
            const structure = Object.fromEntries(
              Object.entries(byAction.structure).flatMap(([key, value]) => {
                const index = Number(key);
                if (index === rowIndex) return [];
                return [
                  [
                    Number.isInteger(index) && index > rowIndex
                      ? String(index - 1)
                      : key,
                    value,
                  ],
                ];
              })
            );
            const next = { ...byAction };
            if (Object.keys(structure).length) next.structure = structure;
            else delete next.structure;
            if (Object.keys(next).length) patches[action] = next;
            else delete patches[action];
          }
          return {
            tableStructure: {
              ...s.tableStructure,
              [tabId]: {
                ...s.tableStructure[tabId],
                [tableWindowId]: rows.filter((_, index) => index !== rowIndex),
              },
            },
            ...(windowData
              ? {
                  dataPatchMap: dataPatchMapWithWindowPatches(
                    s,
                    tabId,
                    tableWindowId,
                    windowData,
                    patches
                  ),
                }
              : {}),
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
        let accepted = true;

        set((s) => {
          const existingRowPatch =
            s.dataPatchMap[tabId]?.[tableWindowId]?.patches?.[action]?.[
              dataKey
            ]?.[rowKey];

          let dataToWrite: Record<string, any> = {
            ...(existingRowPatch ?? {}),
            ...data,
          };
          const tableKey = `${tabId}.${tableWindow.table.schema}.${tableWindow.table.name}`;

          // A row edit or delete records the row it was made against the first
          // time (outside the patches), so saving targets that row wherever the
          // grid has moved since.
          const isRowPatch =
            dataKey === DATA_KEYS.data &&
            (action === DATA_ACTIONS.update || action === DATA_ACTIONS.delete);
          let originalRow: unknown[] | undefined;
          if (isRowPatch) {
            const recorded = recordedRow(
              s.dataPatchMap[tabId]?.[tableWindowId],
              rowKey
            );
            const loaded = loadedOriginalRow(s, tableKey, rowKey);
            // Another row now sits at this position (it was reloaded while a
            // change was pending): never attach this action to the earlier
            // row's change. The grid is read-only while rows are replaced, so
            // this only guards against paths that bypass it.
            if (
              recorded &&
              loaded?.fromCache &&
              !sameLoadedRow(recorded, loaded.row)
            ) {
              accepted = false;
              return s;
            }
            originalRow = recorded ?? loaded?.row;
          }
          const finish = (next: Pick<ConnectionState, "dataPatchMap">) =>
            isRowPatch
              ? withRecordedRow(next, tabId, tableWindowId, rowKey, originalRow)
              : next;

          // If changed value equals original, remove that key from the patch
          if (action === DATA_ACTIONS.update) {
            let original: Record<string, any> | undefined;

            if (dataKey === DATA_KEYS.data) {
              const columns = tableData.columns ?? [];
              if (originalRow && columns.length) {
                original = {};
                for (let i = 0; i < columns.length; i++) {
                  const col = columns[i];
                  if (col?.name) original[col.name] = originalRow[i];
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
                if (isPatchMetaKey(key)) {
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
                    const existingFk = findFkForColumn(
                      meta?.foreignKeys,
                      rowColumn
                    );
                    if (
                      existingFk?.ref_table_name &&
                      existingFk?.ref_column_names
                    ) {
                      origVal = `${existingFk.ref_table_name}(${existingFk.ref_column_names})`;
                    }
                  }
                }
                if (dataKey === DATA_KEYS.structure && key === "tableName") {
                  if (tableRenameTarget(value, String(origVal ?? ""))) {
                    cleaned[key] = value;
                  }
                  continue;
                }
                if (dataKey === DATA_KEYS.structure && key === "is_nullable") {
                  // Same meaning, different spelling (catalog true vs
                  // editor YES) is no change.
                  const same =
                    parseNullable(value) !== undefined &&
                    parseNullable(value) === parseNullable(origVal);
                  if (!same) cleaned[key] = value;
                  continue;
                }
                if (!cellEditValuesEqual(value, origVal)) cleaned[key] = value;
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
            patchFieldEntries(dataToWrite).length === 0
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
            return finish({
              dataPatchMap: dataPatchMapWithWindowPatches(
                s,
                tabId,
                tableWindowId,
                windowData!,
                cleanedPatches
              ),
            });
          }

          return finish({
            dataPatchMap: {
              ...s.dataPatchMap,
              [tabId]: {
                ...(s.dataPatchMap[tabId] ?? {}),
                [tableWindowId]: {
                  tableData,
                  tableWindow,
                  originalRows: windowData?.originalRows,
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
          });
        });
        return accepted;
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

          const next = {
            dataPatchMap: dataPatchMapWithWindowPatches(
              s,
              tabId,
              tableWindowId,
              windowData,
              cleanedPatches
            ),
          };
          return dataKey === DATA_KEYS.data
            ? withRecordedRow(
                next,
                tabId,
                tableWindowId,
                rowKey,
                recordedRow(windowData, rowKey)
              )
            : next;
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

      discardRowPositionPatches: (tabId, tableWindowId) =>
        set((s) => {
          const win = s.dataPatchMap[tabId]?.[tableWindowId];
          if (!win?.patches) return s;
          // Edits were also written into the loaded rows: put the recorded
          // originals back, only where that row still sits (a reload may have
          // put another row there since).
          const tableKey = `${tabId}.${win.tableWindow.table.schema}.${win.tableWindow.table.name}`;
          const rowsState = s.tableRowsByKey[tableKey];
          let rows = rowsState?.rows;
          for (const rowKey of Object.keys(win.patches.update?.data ?? {})) {
            const original = recordedRow(win, rowKey);
            const loaded = loadedOriginalRow(s, tableKey, rowKey);
            const localIndex = parseInt(rowKey, 10);
            if (!rowsState || !rows || !original || isNaN(localIndex)) continue;
            if (loaded?.fromCache && !sameLoadedRow(original, loaded.row)) {
              continue;
            }
            const windowIndex =
              rowsState.streamOffset + localIndex - rowsState.base;
            if (windowIndex < 0 || windowIndex >= rows.length) continue;
            if (rows === rowsState.rows) rows = [...rows];
            rows[windowIndex] = original;
          }
          const { [tableKey]: _selected, ...selectedRowByKey } =
            s.selectedRowByKey;
          return {
            ...(rowsState && rows && rows !== rowsState.rows
              ? {
                  tableRowsByKey: {
                    ...s.tableRowsByKey,
                    [tableKey]: { ...rowsState, rows },
                  },
                }
              : {}),
            // The selected row's details may show a discarded value.
            selectedRowByKey,
            dataPatchMap: {
              ...s.dataPatchMap,
              [tabId]: {
                ...s.dataPatchMap[tabId],
                [tableWindowId]: {
                  ...win,
                  originalRows: {},
                  patches: withoutRowPositionPatches(win.patches),
                },
              },
            },
          };
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
