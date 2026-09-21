import type {
  DatabaseEngine,
  DatabaseObjectItem,
  DatabaseObjectKind,
  OpenWindow,
} from "src/types";
import {
  buildCreateDatabaseObjectTemplate,
  buildSaveStatements,
  defaultNewObjectName,
  getDatabaseObjectCapability,
} from "src/lib/databaseObjects";

export type ObjectCreateDraftState = {
  schema: string;
  name: string;
  tableName: string;
};

export type ObjectCreateDraft = {
  draft: ObjectCreateDraftState;
  kind: DatabaseObjectKind;
  sql: string;
};

export type ObjectEditDraft = {
  item: DatabaseObjectItem;
  sql: string;
  baselineSql: string;
};

/** Survive Object pane remounts when switching tabs (keyed by window id). */
export const objectCreateDraftCache = new Map<string, ObjectCreateDraft>();
export const objectEditDraftCache = new Map<string, ObjectEditDraft>();

export function clearObjectEditorDraft(windowId: string) {
  objectCreateDraftCache.delete(windowId);
  objectEditDraftCache.delete(windowId);
  pendingObjectEditorResets.delete(windowId);
}

/** Pane should restore editor SQL to baseline after discard. */
const pendingObjectEditorResets = new Set<string>();

export function markObjectEditorReset(windowId: string) {
  pendingObjectEditorResets.add(windowId);
}

export function hasObjectEditorReset(windowId: string): boolean {
  return pendingObjectEditorResets.has(windowId);
}

export function consumeObjectEditorReset(windowId: string): boolean {
  if (!pendingObjectEditorResets.has(windowId)) return false;
  pendingObjectEditorResets.delete(windowId);
  return true;
}

export function revertObjectEditDraft(windowId: string): boolean {
  const cached = objectEditDraftCache.get(windowId);
  if (!cached) return false;
  objectEditDraftCache.set(windowId, {
    ...cached,
    sql: cached.baselineSql,
  });
  markObjectEditorReset(windowId);
  return true;
}

export type PendingObjectSaveEntry = {
  windowId: string;
  mode: "create" | "edit";
  statements: string[];
  create?: ObjectCreateDraft;
  edit?: ObjectEditDraft;
};

export function collectPendingObjectSaveEntries(args: {
  openWindows: OpenWindow[];
  engine: DatabaseEngine;
  defaultSchema?: string;
}): PendingObjectSaveEntry[] {
  const result: PendingObjectSaveEntry[] = [];

  for (const w of args.openWindows) {
    if (w.type !== "db-object-manager") continue;

    const objectId = (w.initialObjectId ?? "").trim();
    if (!objectId) {
      let cached = objectCreateDraftCache.get(w.id);
      if (!cached?.sql.trim()) {
        const kind = w.initialKind ?? "function";
        const schema = (args.defaultSchema || "public").trim() || "public";
        const name = w.title?.trim() || defaultNewObjectName(kind);
        const draft = { schema, name, tableName: "" };
        const sql = buildCreateDatabaseObjectTemplate({
          engine: args.engine,
          kind,
          schema,
          name,
          tableName: "",
        });
        cached = { draft, kind, sql };
        objectCreateDraftCache.set(w.id, cached);
      }
      if (!cached.sql.trim()) continue;
      const capability = getDatabaseObjectCapability(args.engine, cached.kind);
      if (!capability.canCreate) continue;
      const statements = buildSaveStatements({
        engine: args.engine,
        item: null,
        sql: cached.sql,
      });
      if (!statements.length) continue;
      result.push({
        windowId: w.id,
        mode: "create",
        statements,
        create: cached,
      });
      continue;
    }

    if (!w.dirty) continue;
    const cached = objectEditDraftCache.get(w.id);
    if (!cached) continue;
    if (!cached.item.capability.canEdit) continue;
    if (cached.sql.trim() === cached.baselineSql.trim()) continue;
    const statements = buildSaveStatements({
      engine: args.engine,
      item: cached.item,
      sql: cached.sql,
    });
    if (!statements.length) continue;
    result.push({
      windowId: w.id,
      mode: "edit",
      statements,
      edit: cached,
    });
  }

  return result;
}

export function collectPendingObjectSql(args: {
  openWindows: OpenWindow[];
  engine: DatabaseEngine;
  defaultSchema?: string;
}): string[] {
  return collectPendingObjectSaveEntries(args).flatMap(
    (entry) => entry.statements
  );
}

export type ObjectChangeSummary = {
  insertFunctions: number;
  insertProcedures: number;
  insertTriggers: number;
  updateFunctions: number;
  updateProcedures: number;
  updateTriggers: number;
};

export function emptyObjectChangeSummary(): ObjectChangeSummary {
  return {
    insertFunctions: 0,
    insertProcedures: 0,
    insertTriggers: 0,
    updateFunctions: 0,
    updateProcedures: 0,
    updateTriggers: 0,
  };
}

/** Classify by window mode (create vs edit), not by CREATE OR REPLACE text. */
export function summarizePendingObjectEntries(
  entries: PendingObjectSaveEntry[]
): ObjectChangeSummary {
  const summary = emptyObjectChangeSummary();

  for (const entry of entries) {
    if (entry.mode === "create" && entry.create) {
      if (entry.create.kind === "function") summary.insertFunctions += 1;
      else if (entry.create.kind === "procedure") summary.insertProcedures += 1;
      else summary.insertTriggers += 1;
      continue;
    }
    if (entry.mode === "edit" && entry.edit) {
      const kind = entry.edit.item.kind;
      if (kind === "function") summary.updateFunctions += 1;
      else if (kind === "procedure") summary.updateProcedures += 1;
      else summary.updateTriggers += 1;
    }
  }

  return summary;
}

export function collectObjectChangeSummary(args: {
  openWindows: OpenWindow[];
  engine: DatabaseEngine;
  defaultSchema?: string;
}): ObjectChangeSummary {
  return summarizePendingObjectEntries(collectPendingObjectSaveEntries(args));
}
