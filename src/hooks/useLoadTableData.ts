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
import { runSqlQuery, startSqlQueryStream } from "src/lib/tauri/query";
import { operationBus } from "src/lib/tauri/operationBus";
import { operationCancel, TableChunk } from "src/lib/tauri";
import { useConnectionStore } from "src/stores/connection";

export function tableKey(
  activeScreen: string,
  schema: string,
  tableName: string
) {
  return `${activeScreen}.${schema}.${tableName}`;
}

export type TablePagination = { limit: number; offset: number };
export const DEFAULT_LIMIT = 300;
export const DEFAULT_OFFSET = 0;

const EMPTY_META = {
  columns: null,
  structure: null,
  constraints: null,
  sizeInfo: null,
  rowCount: null,
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

type LoadPlan = {
  key: string;
  prev: any;

  force: boolean;
  isFirstLoad: boolean;

  needColumns: boolean;
  needRows: boolean;
  needRowCount: boolean;
  needSizeInfo: boolean;
  needMeta: boolean;
};

type BusyGate = {
  markNonRowDone: () => void;
  markRowsDone: () => void;
  fail: (err: unknown) => void;
};

function computeLoadPlan(key: string, prev: any, flags: LoadFlags): LoadPlan {
  const force = !!flags.force;

  const refreshRows = flags.refreshRows ?? true;
  const refreshMeta = flags.refreshMeta ?? false;
  const refreshStats = flags.refreshStats ?? false;

  const hasColumns = Array.isArray(prev.columns) && prev.columns.length > 0;

  // Rows "existence" is now based on rows store state (not tableDataMap)
  // We'll treat first load as "no columns OR no rows window init"
  const rowsInfo = useConnectionStore.getState().getRowsWindowInfo(key);
  const hasRowsWindow = !!rowsInfo;

  const hasRowCount = typeof prev.rowCount === "number" && prev.rowCount >= 0;
  const hasSizeInfo = !!prev.sizeInfo;

  const hasStructure =
    Array.isArray(prev.structure) && prev.structure.length > 0;
  const hasConstraints =
    Array.isArray(prev.constraints) && prev.constraints.length > 0;

  const isFirstLoad = !hasColumns || !hasRowsWindow;

  const metaMissing = !hasStructure || !hasConstraints;

  // ✅ first load must fetch minimum dataset (columns + rows)
  const needColumns = force || isFirstLoad || !hasColumns;
  const needRows = force || isFirstLoad || refreshRows;

  // ✅ stats/meta:
  // - First load: do NOT fetch by default (unless force)
  // - Later: fetch if missing OR explicitly requested via flags
  const needRowCount =
    force || (!isFirstLoad && (!hasRowCount || refreshStats));
  const needSizeInfo =
    force || (!isFirstLoad && (!hasSizeInfo || refreshStats));
  const needMeta = force || (!isFirstLoad && (metaMissing || refreshMeta));

  return {
    key,
    prev,
    force,
    isFirstLoad,
    needColumns,
    needRows,
    needRowCount,
    needSizeInfo,
    needMeta,
  };
}

function shouldDoAnything(p: LoadPlan) {
  return (
    p.needColumns ||
    p.needRows ||
    p.needRowCount ||
    p.needSizeInfo ||
    p.needMeta
  );
}

function createBusyGate(params: {
  key: string;
  prev: any;
  setMeta: (key: string, patch: any) => void;
  needRows: boolean;
}): BusyGate {
  const { key, prev, setMeta, needRows } = params;

  let nonRowDone = false;
  let rowsDone = !needRows;
  let failed = false;

  const maybeFinalizeBusy = () => {
    if (failed) return;
    if (!nonRowDone) return;
    if (!rowsDone) return;

    const cur = useConnectionStore.getState().tableDataMap[key] ?? prev;
    setMeta(key, { ...cur, busy: false, error: cur.error ?? null });
  };

  return {
    markNonRowDone() {
      nonRowDone = true;
      maybeFinalizeBusy();
    },
    markRowsDone() {
      rowsDone = true;
      maybeFinalizeBusy();
    },
    fail(err: unknown) {
      if (failed) return;
      failed = true;

      const cur = useConnectionStore.getState().tableDataMap[key] ?? prev;
      setMeta(key, {
        ...cur,
        busy: false,
        error: getErrorMessage(err),
      });
    },
  };
}

async function loadColumns(params: {
  connId: string;
  schema: string;
  tableName: string;
  addLogQuery: (sql: string) => void;
}): Promise<ColumnRow[]> {
  const { connId, schema, tableName, addLogQuery } = params;

  const q = tableColumnsQuery(schema, tableName);
  const res = await runSqlQuery(connId, q);
  addLogQuery(q);

  return (res.rows as unknown[][])
    .map((r) => ({
      name: cellToString(r?.[0]),
      db_type: cellToString(r?.[1]),
    }))
    .filter(isNonEmptyName);
}

async function loadRowCount(params: {
  connId: string;
  schema: string;
  tableName: string;
  addLogQuery: (sql: string) => void;
}): Promise<number> {
  const { connId, schema, tableName, addLogQuery } = params;

  const q = tableRowCountQuery(schema, tableName);
  const res = await runSqlQuery(connId, q);
  addLogQuery(q);

  return Number(cellToString((res.rows as unknown[][])?.[0]?.[0]));
}

async function loadSizeInfo(params: {
  connId: string;
  schema: string;
  tableName: string;
  addLogQuery: (sql: string) => void;
}): Promise<{ totalSize: string; dataSize: string; indexSize: string }> {
  const { connId, schema, tableName, addLogQuery } = params;

  const q = tableSizeInfoQuery(schema, tableName);
  const res = await runSqlQuery(connId, q);
  addLogQuery(q);

  const r0 = (res.rows as unknown[][])?.[0] ?? [];
  return {
    totalSize: cellToString(r0?.[0]),
    dataSize: cellToString(r0?.[1]),
    indexSize: cellToString(r0?.[2]),
  };
}

async function loadMeta(params: {
  connId: string;
  schema: string;
  tableName: string;
  addLogQuery: (sql: string) => void;
}): Promise<{ structure: any[]; constraints: any[] }> {
  const { connId, schema, tableName, addLogQuery } = params;

  const qOid = tableOidQuery(schema, tableName);
  const oidRes = await runSqlQuery(connId, qOid);
  addLogQuery(qOid);

  const oid = Number(cellToString((oidRes.rows as unknown[][])?.[0]?.[0]));

  const qStructure = tableStructuresQuery(schema, tableName, oid);
  const structureRes = await runSqlQuery(connId, qStructure);
  addLogQuery(qStructure);

  const structure = (structureRes.rows as unknown[][]).map((row) => ({
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

  const constraints = (constraintsRes.rows as unknown[][]).map((row) => ({
    index_name: cellToString(row?.[0]),
    index_algorithm: cellToString(row?.[1]),
    is_unique: cellToString(row?.[2]).toLowerCase() === "true",
    index_definition: cellToString(row?.[3]),
    column_name: cellToString(row?.[4]),
    condition: cellToString(row?.[5]),
    include: cellToString(row?.[6]),
    comment: cellToString(row?.[7]),
  }));

  return { structure, constraints };
}

async function startRowsStream(params: {
  key: string;
  prev: any;
  connId: string;
  schema: string;
  tableName: string;
  pagination?: TablePagination;
  addLogQuery: (sql: string) => void;
  setMeta: (key: string, patch: any) => void;
  gate: BusyGate;
}): Promise<void> {
  const {
    key,
    prev,
    connId,
    schema,
    tableName,
    pagination,
    addLogQuery,
    setMeta,
    gate,
  } = params;

  const limit = pagination?.limit ?? DEFAULT_LIMIT;
  const offset = pagination?.offset ?? DEFAULT_OFFSET;

  const q = tableDataQuery(schema, tableName, { limit, offset });
  addLogQuery(q);

  const store = useConnectionStore.getState();

  // Ensure rows window exists
  store.initRows(key, 5000);

  // Cancel previous stream if any
  const old = store.getRowsWindowInfo(key);
  const oldOpId = old?.opId;
  if (oldOpId) {
    try {
      await operationCancel(oldOpId);
    } catch {}
  }

  const rowsOpId = await startSqlQueryStream(connId, q, {
    batchSize: 200,
    maxRows: limit, // ✅ tight window fetch
  });

  // Cap should be >= limit (+ overscan)
  const cap = Math.max(1000, limit * 4);

  // IMPORTANT: base must align with the global offset
  // This requires store.beginRowsStream to accept streamOffset (4th arg)
  store.beginRowsStream(key, rowsOpId, cap, offset);

  let unsub: (() => void) | null = null;

  unsub = await operationBus.subscribe(rowsOpId, {
    onChunk: (chunk: TableChunk) => {
      // Apply chunk into viewport window only (drop outside window)
      useConnectionStore.getState().applyRowsChunk(key, rowsOpId, chunk);
    },

    onDone: (_done: any) => {
      const cur = useConnectionStore.getState().getRowsWindowInfo(key);
      if (!cur || cur.opId !== rowsOpId) return;

      try {
        unsub?.();
      } catch {}
      unsub = null;

      useConnectionStore.getState().endRowsStream(key, rowsOpId);
      gate.markRowsDone();
    },

    onError: (err: any) => {
      const cur = useConnectionStore.getState().getRowsWindowInfo(key);
      if (!cur || cur.opId !== rowsOpId) return;

      try {
        unsub?.();
      } catch {}
      unsub = null;

      useConnectionStore
        .getState()
        .failRowsStream(key, rowsOpId, getErrorMessage(err));

      // Also reflect error on meta state for UX
      const metaCur = useConnectionStore.getState().tableDataMap[key] ?? prev;
      setMeta(key, { ...metaCur, error: getErrorMessage(err) });

      gate.fail(err);
    },
  });
}

function applyColumnsPatch(params: {
  key: string;
  prev: any;
  connId: string;
  columns: ColumnRow[];
  setMeta: (key: string, patch: any) => void;
}) {
  const { key, prev, connId, columns, setMeta } = params;

  const cur = useConnectionStore.getState().tableDataMap[key] ?? prev;
  setMeta(key, {
    ...cur,
    columns,
    connectionId: cur.connectionId ?? connId,
    busy: true,
    error: null,
  });
}

function applyRowCountPatch(params: {
  key: string;
  prev: any;
  connId: string;
  rowCount: number;
  setMeta: (key: string, patch: any) => void;
}) {
  const { key, prev, connId, rowCount, setMeta } = params;

  const cur = useConnectionStore.getState().tableDataMap[key] ?? prev;
  setMeta(key, {
    ...cur,
    rowCount,
    connectionId: cur.connectionId ?? connId,
    busy: true,
    error: null,
  });
}

function applySizeInfoPatch(params: {
  key: string;
  prev: any;
  connId: string;
  sizeInfo: any;
  setMeta: (key: string, patch: any) => void;
}) {
  const { key, prev, connId, sizeInfo, setMeta } = params;

  const cur = useConnectionStore.getState().tableDataMap[key] ?? prev;
  setMeta(key, {
    ...cur,
    sizeInfo,
    connectionId: cur.connectionId ?? connId,
    busy: true,
    error: null,
  });
}

function applyMetaPatch(params: {
  key: string;
  prev: any;
  connId: string;
  structure: any[];
  constraints: any[];
  setMeta: (key: string, patch: any) => void;
}) {
  const { key, prev, connId, structure, constraints, setMeta } = params;

  const cur = useConnectionStore.getState().tableDataMap[key] ?? prev;
  setMeta(key, {
    ...cur,
    structure,
    constraints,
    connectionId: cur.connectionId ?? connId,
    busy: true,
    error: null,
  });
}

export function useLoadTableData() {
  const tableDataMap = useConnectionStore((s) => s.tableDataMap);
  const setMeta = useConnectionStore((s) => s.addTableDataMap);
  const removeMeta = useConnectionStore((s) => s.removeTableDataMap);
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

      const meta = tableDataMap[key];
      if (meta?.connectionId) return meta.connectionId;

      const res = await profileConnect(activeTab.profileId);
      return res.connection.id;
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
      const prev = (tableDataMap[key] ?? EMPTY_META) as any;

      const plan = computeLoadPlan(key, prev, flags);
      if (!shouldDoAnything(plan)) return;

      setMeta(key, { ...prev, busy: true, error: null });

      const gate = createBusyGate({
        key,
        prev,
        setMeta,
        needRows: plan.needRows,
      });

      try {
        const connId = await ensureRuntimeConn(key);

        // Always keep connectionId updated early (helps later ops)
        setMeta(key, {
          ...prev,
          connectionId: prev.connectionId ?? connId,
          busy: true,
          error: null,
        });

        if (plan.needRows) {
          await startRowsStream({
            key,
            prev,
            connId,
            schema,
            tableName,
            pagination,
            addLogQuery,
            setMeta,
            gate,
          });
        }

        if (plan.needColumns) {
          const columns = await loadColumns({
            connId,
            schema,
            tableName,
            addLogQuery,
          });
          applyColumnsPatch({ key, prev, connId, columns, setMeta });
        }

        if (plan.needRowCount) {
          const rowCount = await loadRowCount({
            connId,
            schema,
            tableName,
            addLogQuery,
          });
          applyRowCountPatch({ key, prev, connId, rowCount, setMeta });
        }

        if (plan.needSizeInfo) {
          const sizeInfo = await loadSizeInfo({
            connId,
            schema,
            tableName,
            addLogQuery,
          });
          applySizeInfoPatch({ key, prev, connId, sizeInfo, setMeta });
        }

        if (plan.needMeta) {
          const { structure, constraints } = await loadMeta({
            connId,
            schema,
            tableName,
            addLogQuery,
          });
          applyMetaPatch({
            key,
            prev,
            connId,
            structure,
            constraints,
            setMeta,
          });
        }

        gate.markNonRowDone();
      } catch (e: unknown) {
        gate.fail(e);
      }
    },
    [
      activeTab,
      activeProfileScreen,
      tableDataMap,
      setMeta,
      ensureRuntimeConn,
      addLogQuery,
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

      // Cancel row stream if running + cleanup row window state
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
