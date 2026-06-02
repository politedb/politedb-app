import { runRedisCommand } from "src/lib/tauri/redis";
import { tableKey } from "src/lib/table-data";
import { useConnectionStore } from "src/stores/connection";
import type { PatchApplyContext, PatchMapEntry } from "./types";

export async function applyRedisPatchEntry(
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
      "Redis table view currently supports updating existing values only."
    );
  }

  const store = useConnectionStore.getState();
  const key = tableKey(
    ctx.activeProfileScreen,
    tableWindow.table.schema,
    tableWindow.table.name
  );
  const cols = store.tableDataMap[key]?.columns ?? [];
  const cache = store.tableRowCacheByKey[key];

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

    if (cols.length === 1 && cols[0]?.name === "value") {
      if (!Object.prototype.hasOwnProperty.call(raw, "value")) continue;
      await runRedisCommand(ctx.runtimeConnectionId, "SET", [
        tableWindow.table.name,
        String(raw.value ?? ""),
      ]);
      continue;
    }

    if (
      cols.length >= 2 &&
      cols[0]?.name === "field" &&
      cols[1]?.name === "value"
    ) {
      if (!Object.prototype.hasOwnProperty.call(raw, "value")) continue;
      if (Object.prototype.hasOwnProperty.call(raw, "field")) {
        throw new Error(
          "Redis hash fields cannot be renamed from table view."
        );
      }
      const fieldValue = String(sourceRow[0] ?? "");
      await runRedisCommand(ctx.runtimeConnectionId, "HSET", [
        tableWindow.table.name,
        fieldValue,
        String(raw.value ?? ""),
      ]);
      continue;
    }

    throw new Error("Redis edit is not supported for this key type yet.");
  }
}
