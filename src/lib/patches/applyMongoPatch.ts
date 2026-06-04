import {
  mongoDeleteDocuments,
  mongoInsertDocuments,
  mongoUpdateDocuments,
} from "src/lib/tauri/mongo";
import { tableKey } from "src/lib/table-data";
import { useConnectionStore } from "src/stores/connection";
import {
  mongoCellToValue,
  resolveRowIndex,
  type PatchApplyContext,
  type PatchMapEntry,
} from "./types";

export async function applyMongoPatchEntry(
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
    Object.keys(patches?.create?.structure ?? {}).length > 0 ||
    Object.keys(patches?.update?.structure ?? {}).length > 0 ||
    Object.keys(patches?.delete?.structure ?? {}).length > 0 ||
    Object.keys(patches?.create?.constraints ?? {}).length > 0 ||
    Object.keys(patches?.update?.constraints ?? {}).length > 0 ||
    Object.keys(patches?.delete?.constraints ?? {}).length > 0;

  if (hasUnsupportedPatches) {
    throw new Error(
      "Mongo does not support structure/constraint patches in table view."
    );
  }

  const store = useConnectionStore.getState();
  const key = tableKey(
    ctx.activeProfileScreen,
    tableWindow.table.schema,
    tableWindow.table.name
  );
  const cols = store.tableDataMap[key]?.columns ?? [];
  const idColIdx = cols.findIndex((c) => c.name === "_id");
  if (idColIdx < 0) {
    throw new Error("MONGO_ID_COLUMN_NOT_FOUND");
  }

  const documents = Object.values(createData).map((patch) => {
    const raw = (patch ?? {}) as Record<string, unknown>;
    const doc: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(raw)) {
      if (k === "__rowKey") continue;
      if (k === "_id" && (v === null || String(v ?? "").trim() === "")) {
        continue;
      }
      doc[k] = v;
    }

    return doc;
  });

  const updates = Object.entries(updateData)
    .map(([rowKey, patch]) => {
      const resolved = resolveRowIndex(rowKey, ctx.offset, key, store);
      if (!resolved) return null;

      const raw = (patch ?? {}) as Record<string, unknown>;
      if ("_id" in raw) {
        throw new Error("Mongo _id is immutable and cannot be updated.");
      }

      const idValue = mongoCellToValue(resolved.sourceRow[idColIdx]);
      if (idValue == null || String(idValue).trim() === "") {
        return null;
      }

      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k === "__rowKey" || k === "_id") continue;
        set[k] = v;
      }

      if (Object.keys(set).length === 0) return null;
      return { id: idValue, set };
    })
    .filter(Boolean) as Array<{
    id: unknown;
    set: Record<string, unknown>;
  }>;

  const deleteIds = Object.keys(deleteData)
    .map((rowKey) => {
      const resolved = resolveRowIndex(rowKey, ctx.offset, key, store);
      if (!resolved) return null;

      const idValue = mongoCellToValue(resolved.sourceRow[idColIdx]);
      if (idValue == null || String(idValue).trim() === "") {
        return null;
      }
      return idValue;
    })
    .filter((v) => v !== null) as unknown[];

  if (documents.length > 0) {
    await mongoInsertDocuments({
      connectionId: ctx.runtimeConnectionId,
      database: tableWindow.table.schema,
      collection: tableWindow.table.name,
      documents,
    });
  }
  if (updates.length > 0) {
    await mongoUpdateDocuments({
      connectionId: ctx.runtimeConnectionId,
      database: tableWindow.table.schema,
      collection: tableWindow.table.name,
      updates,
    });
  }
  if (deleteIds.length > 0) {
    await mongoDeleteDocuments({
      connectionId: ctx.runtimeConnectionId,
      database: tableWindow.table.schema,
      collection: tableWindow.table.name,
      ids: deleteIds,
    });
  }
}
