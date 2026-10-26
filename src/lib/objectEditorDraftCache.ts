import type { DatabaseEngine } from "src/types";
import {
  buildSaveStatements,
  getDatabaseObjectCapability,
} from "src/lib/databaseObjects";
import {
  canExecute,
  hasPendingWork,
  objectDraftsForTab,
  type ObjectDraft,
} from "src/stores/objectDrafts";

/**
 * What saving a connection tab's object drafts would run, read from the
 * draft store (closed windows included). Read-only: nothing is seeded here.
 */
export type PendingObjectSaveEntry = {
  key: string;
  mode: "create" | "edit";
  statements: string[];
  /** The draft as submitted: completion compares against it. */
  snapshot: ObjectDraft;
};

/** A draft with unsaved work that this save will not run, and why. */
export type SkippedObjectDraft = {
  key: string;
  name: string;
  reason: string;
};

function capabilityAllows(draft: ObjectDraft, engine: DatabaseEngine) {
  if (draft.mode === "create") {
    return getDatabaseObjectCapability(engine, draft.kind).canCreate;
  }
  return !!draft.item?.capability.canEdit;
}

export function collectPendingObjectSaveEntries(args: {
  tabId: string;
  engine: DatabaseEngine;
}): PendingObjectSaveEntry[] {
  const result: PendingObjectSaveEntry[] = [];
  for (const draft of objectDraftsForTab(args.tabId)) {
    if (!canExecute(draft) || !capabilityAllows(draft, args.engine)) continue;
    const statements = buildSaveStatements({
      engine: args.engine,
      item: draft.mode === "edit" ? (draft.item ?? null) : null,
      sql: draft.sql,
    });
    if (!statements.length) continue;
    result.push({
      key: draft.key,
      mode: draft.mode,
      statements,
      snapshot: draft,
    });
  }
  return result;
}

/** Unsaved drafts that cannot run now (empty SQL, missing object, ...). */
export function collectSkippedObjectDrafts(args: {
  tabId: string;
  engine: DatabaseEngine;
}): SkippedObjectDraft[] {
  const skipped: SkippedObjectDraft[] = [];
  for (const draft of objectDraftsForTab(args.tabId)) {
    if (!hasPendingWork(draft)) continue;
    const name = draft.form.name || draft.item?.name || "object";
    if (draft.saving) continue;
    if (draft.missing) {
      skipped.push({
        key: draft.key,
        name,
        reason: "no longer exists in the database",
      });
    } else if (!draft.sql.trim()) {
      skipped.push({ key: draft.key, name, reason: "its SQL is empty" });
    } else if (!capabilityAllows(draft, args.engine)) {
      skipped.push({
        key: draft.key,
        name,
        reason: "this database cannot save it here",
      });
    }
  }
  return skipped;
}

/** What the save review says about object drafts beyond their SQL. */
export type ObjectSaveNotice =
  | { kind: "skipped"; key: string; name: string; reason: string }
  | { kind: "conflict"; key: string; name: string };

/**
 * Unsaved drafts this save leaves as they are (and why), and drafts it
 * runs although their definition changed in the database since loaded.
 */
export function collectObjectSaveNotices(args: {
  tabId: string;
  engine: DatabaseEngine;
}): ObjectSaveNotice[] {
  const conflicts: ObjectSaveNotice[] = collectPendingObjectSaveEntries(args)
    .filter((entry) => entry.snapshot.conflict)
    .map((entry) => ({
      kind: "conflict",
      key: entry.key,
      name: entry.snapshot.form.name || entry.snapshot.item?.name || "object",
    }));
  const skipped: ObjectSaveNotice[] = collectSkippedObjectDrafts(args).map(
    (s) => ({ kind: "skipped", ...s })
  );
  return [...conflicts, ...skipped];
}

export function collectPendingObjectSql(args: {
  tabId: string;
  engine: DatabaseEngine;
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

/** Classify by draft mode (create vs edit), not by CREATE OR REPLACE text. */
export function summarizePendingObjectEntries(
  entries: PendingObjectSaveEntry[]
): ObjectChangeSummary {
  const summary = emptyObjectChangeSummary();

  for (const entry of entries) {
    const kind = entry.snapshot.kind;
    if (entry.mode === "create") {
      if (kind === "function") summary.insertFunctions += 1;
      else if (kind === "procedure") summary.insertProcedures += 1;
      else summary.insertTriggers += 1;
      continue;
    }
    if (kind === "function") summary.updateFunctions += 1;
    else if (kind === "procedure") summary.updateProcedures += 1;
    else summary.updateTriggers += 1;
  }

  return summary;
}

export function collectObjectChangeSummary(args: {
  tabId: string;
  engine: DatabaseEngine;
}): ObjectChangeSummary {
  return summarizePendingObjectEntries(collectPendingObjectSaveEntries(args));
}
