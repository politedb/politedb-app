import {
  cassandraPrimaryKeyColumns,
  cassandraUpdateRows,
} from "src/lib/tauri/cassandra";
import { tableKey } from "src/lib/table-data";
import { useConnectionStore } from "src/stores/connection";
import {
  patchValueToString,
  type PatchApplyContext,
  type PatchMapEntry,
} from "./types";

export async function applyCassandraPatchEntry(
  entry: PatchMapEntry,
  ctx: PatchApplyContext
): Promise<void> {
  const tableWindow = entry.tableWindow;
  if (!ctx.runtimeConnectionId || !tableWindow) return;

  const patches = entry.patches;
  const createData = patches?.create?.data ?? {};
  const updateData = patches?.update?.data ?? {};
  const deleteData = patches?.delete?.data ?? {};

  const hasUnsupportedPatches =
    Object.keys(createData).length > 0 ||
    Object.keys(deleteData).length > 0 ||
    Object.keys(patches?.create?.structure ?? {}).length > 0 ||
    Object.keys(patches?.update?.structure ?? {}).length > 0 ||
    Object.keys(patches?.delete?.structure ?? {}).length > 0 ||
    Object.keys(patches?.create?.constraints ?? {}).length > 0 ||
    Object.keys(patches?.update?.constraints ?? {}).length > 0 ||
    Object.keys(patches?.delete?.constraints ?? {}).length > 0;

  if (hasUnsupportedPatches) {
    throw new Error(
      "Cassandra table view currently supports updating existing rows only."
    );
  }

  const pkCols = await cassandraPrimaryKeyColumns({
    connectionId: ctx.runtimeConnectionId,
    keyspace: tableWindow.table.schema,
    table: tableWindow.table.name,
  });

  if (!pkCols.length) {
    throw new Error("Cassandra primary key columns could not be resolved.");
  }

  const store = useConnectionStore.getState();
  const key = tableKey(
    ctx.activeProfileScreen,
    tableWindow.table.schema,
    tableWindow.table.name
  );
  const cols = store.tableDataMap[key]?.columns ?? [];
  const cache = store.tableRowCacheByKey[key];
  const colIndex = new Map(
    cols.map((col, idx) => [col?.name ?? "", idx] as const)
  );

  const updates: Array<{
    pk: Record<string, string>;
    set: Record<string, string>;
  }> = [];

  for (const [rowKey, patch] of Object.entries(updateData)) {
    const rowIndex = Number(rowKey);
    if (!Number.isFinite(rowIndex) || rowIndex < 0) continue;

    const raw = (patch ?? {}) as Record<string, unknown>;
    const candidateIndices = [rowIndex, rowIndex + ctx.offset];
    const resolvedIndex =
      candidateIndices.find(
        (idx) =>
          Boolean(cache?.map.get(idx)) || Boolean(store.getRowAt(key, idx))
      ) ?? rowIndex;

    const sourceRow =
      cache?.map.get(resolvedIndex) ?? store.getRowAt(key, resolvedIndex);
    if (!sourceRow || !Array.isArray(sourceRow)) continue;

    const pk: Record<string, string> = {};
    for (const colName of pkCols) {
      const idx = colIndex.get(colName);
      if (idx == null) {
        throw new Error(
          `Cassandra primary key column "${colName}" is missing from the loaded table.`
        );
      }
      const v = patchValueToString(sourceRow[idx]);
      if (!v.trim()) {
        throw new Error(
          `Cassandra primary key column "${colName}" cannot be empty.`
        );
      }
      pk[colName] = v;
    }

    const set: Record<string, string> = {};
    for (const [colName, value] of Object.entries(raw)) {
      if (colName === "__rowKey" || pkCols.includes(colName)) continue;
      const next = patchValueToString(value);
      if (!next.trim()) continue;
      set[colName] = next;
    }

    if (Object.keys(set).length > 0) {
      updates.push({ pk, set });
    }
  }

  if (updates.length > 0) {
    await cassandraUpdateRows({
      connectionId: ctx.runtimeConnectionId,
      keyspace: tableWindow.table.schema,
      table: tableWindow.table.name,
      updates,
    });
  }
}
