import { create } from "zustand";
import type { DatabaseObjectItem, DatabaseObjectKind } from "src/types";

/**
 * Unsaved function/procedure/trigger work, the one place it lives: per
 * connection screen tab, then per draft key (see src/lib/objectDraftKey).
 * Drafts outlive their windows (closing a tab keeps them, like table
 * changes) and are removed only by saving or discarding. Not persisted.
 */

export type ObjectDraftForm = {
  schema: string;
  name: string;
  tableName: string;
};

export type ObjectDraft = {
  key: string;
  mode: "create" | "edit";
  kind: DatabaseObjectKind;
  form: ObjectDraftForm;
  sql: string;
  /** Edit: the definition as fetched (or last saved). Create: its template. */
  baselineSql: string;
  /** Edit: the object being edited. */
  item?: DatabaseObjectItem;
  /** Edit: the definition has been fetched at least once. */
  loaded: boolean;
  /** Bumped by every SQL, form, kind or baseline change. */
  revision: number;
  /** New for every created, re-created, reverted or discarded draft. */
  generation: number;
  /** A save of this draft is running (create drafts are read-only then). */
  saving: boolean;
  /** Edit: the database definition changed since the baseline. */
  conflict: boolean;
  /** Edit: a complete metadata refresh no longer lists the object. */
  missing: boolean;
};

let lastGeneration = 0;
const nextGeneration = () => ++lastGeneration;

/** The newest generation handed out: drafts created later have a higher one. */
export function currentDraftGeneration(): number {
  return lastGeneration;
}

/** Unsaved work: a create until saved or discarded; an edit that differs. */
export function hasPendingWork(draft: ObjectDraft): boolean {
  if (draft.mode === "create") return true;
  return draft.loaded && draft.sql.trim() !== draft.baselineSql.trim();
}

/** Work Mod+S can run now. */
export function canExecute(draft: ObjectDraft): boolean {
  return (
    hasPendingWork(draft) &&
    draft.sql.trim() !== "" &&
    !draft.missing &&
    !draft.saving
  );
}

type DraftsByTab = Record<string, Record<string, ObjectDraft>>;

type ObjectDraftState = {
  drafts: DraftsByTab;
  ensureCreateDraft: (
    tabId: string,
    key: string,
    init: { kind: DatabaseObjectKind; form: ObjectDraftForm; sql: string }
  ) => void;
  ensureEditDraft: (
    tabId: string,
    key: string,
    item: DatabaseObjectItem
  ) => void;
  setSql: (tabId: string, key: string, sql: string) => void;
  setCreateFields: (
    tabId: string,
    key: string,
    patch: Partial<{
      kind: DatabaseObjectKind;
      form: Partial<ObjectDraftForm>;
      sql: string;
    }>
  ) => void;
  /**
   * A fetched definition: refreshes a clean edit, flags a dirty one. Given
   * the revision the request started at, a response that any edit, save or
   * revert has overtaken is dropped.
   */
  applyDefinition: (
    tabId: string,
    key: string,
    generation: number,
    sql: string,
    item: DatabaseObjectItem,
    revision?: number
  ) => void;
  /** Edit saved: the submitted SQL becomes the baseline; newer text stays. */
  markSaved: (
    tabId: string,
    key: string,
    generation: number,
    submittedSql: string
  ) => void;
  setSaving: (tabId: string, key: string, saving: boolean) => void;
  /** Edit back to its baseline. */
  revert: (tabId: string, key: string) => void;
  remove: (tabId: string, key: string) => void;
  /**
   * Edits whose object a complete refresh no longer lists. With
   * `upToGeneration`, drafts created, re-created or reverted after the
   * refresh started are left alone.
   */
  syncMissing: (
    tabId: string,
    presentObjectIds: Set<string>,
    upToGeneration?: number
  ) => void;
  clearTab: (tabId: string) => void;
  clearAll: () => void;
};

function updateDraft(
  drafts: DraftsByTab,
  tabId: string,
  key: string,
  change: (draft: ObjectDraft) => ObjectDraft | null
): DraftsByTab {
  const tab = drafts[tabId];
  const draft = tab?.[key];
  if (!tab || !draft) return drafts;
  const next = change(draft);
  if (next === draft) return drafts;
  const { [key]: _old, ...rest } = tab;
  return {
    ...drafts,
    [tabId]: next ? { ...rest, [key]: next } : rest,
  };
}

function putDraft(
  drafts: DraftsByTab,
  tabId: string,
  draft: ObjectDraft
): DraftsByTab {
  return {
    ...drafts,
    [tabId]: { ...(drafts[tabId] ?? {}), [draft.key]: draft },
  };
}

export const useObjectDraftStore = create<ObjectDraftState>((set) => ({
  drafts: {},

  ensureCreateDraft: (tabId, key, init) =>
    set((s) => {
      if (s.drafts[tabId]?.[key]) return s;
      return {
        drafts: putDraft(s.drafts, tabId, {
          key,
          mode: "create",
          kind: init.kind,
          form: init.form,
          sql: init.sql,
          baselineSql: init.sql,
          loaded: true,
          revision: 0,
          generation: nextGeneration(),
          saving: false,
          conflict: false,
          missing: false,
        }),
      };
    }),

  ensureEditDraft: (tabId, key, item) =>
    set((s) => {
      if (s.drafts[tabId]?.[key]) return s;
      return {
        drafts: putDraft(s.drafts, tabId, {
          key,
          mode: "edit",
          kind: item.kind,
          form: {
            schema: item.schema,
            name: item.name,
            tableName: item.tableName ?? "",
          },
          sql: "",
          baselineSql: "",
          item,
          loaded: false,
          revision: 0,
          generation: nextGeneration(),
          saving: false,
          conflict: false,
          missing: false,
        }),
      };
    }),

  setSql: (tabId, key, sql) =>
    set((s) => ({
      drafts: updateDraft(s.drafts, tabId, key, (d) =>
        d.sql === sql || (d.mode === "create" && d.saving)
          ? d
          : { ...d, sql, revision: d.revision + 1 }
      ),
    })),

  setCreateFields: (tabId, key, patch) =>
    set((s) => ({
      drafts: updateDraft(s.drafts, tabId, key, (d) => {
        if (d.mode !== "create" || d.saving) return d;
        return {
          ...d,
          kind: patch.kind ?? d.kind,
          form: { ...d.form, ...(patch.form ?? {}) },
          sql: patch.sql ?? d.sql,
          revision: d.revision + 1,
        };
      }),
    })),

  applyDefinition: (tabId, key, generation, sql, item, revision) =>
    set((s) => ({
      drafts: updateDraft(s.drafts, tabId, key, (d) => {
        if (d.mode !== "edit" || d.generation !== generation) return d;
        if (revision !== undefined && d.revision !== revision) return d;
        const pending = d.loaded && d.sql.trim() !== d.baselineSql.trim();
        if (!pending) {
          return {
            ...d,
            item,
            sql,
            baselineSql: sql,
            loaded: true,
            conflict: false,
            // `missing` belongs to metadata refreshes (syncMissing) only.
          };
        }
        // Pending work is never overwritten; only say the database moved.
        const conflict = sql.trim() !== d.baselineSql.trim();
        return conflict === d.conflict ? d : { ...d, conflict, item };
      }),
    })),

  markSaved: (tabId, key, generation, submittedSql) =>
    set((s) => ({
      drafts: updateDraft(s.drafts, tabId, key, (d) =>
        d.mode !== "edit" || d.generation !== generation
          ? d
          : {
              ...d,
              baselineSql: submittedSql,
              conflict: false,
              // A definition fetched before this save is now stale.
              revision: d.revision + 1,
            }
      ),
    })),

  setSaving: (tabId, key, saving) =>
    set((s) => ({
      drafts: updateDraft(s.drafts, tabId, key, (d) =>
        d.saving === saving ? d : { ...d, saving }
      ),
    })),

  revert: (tabId, key) =>
    set((s) => ({
      drafts: updateDraft(s.drafts, tabId, key, (d) =>
        d.mode !== "edit"
          ? d
          : {
              ...d,
              sql: d.baselineSql,
              conflict: false,
              revision: d.revision + 1,
              generation: nextGeneration(),
            }
      ),
    })),

  remove: (tabId, key) =>
    set((s) => ({ drafts: updateDraft(s.drafts, tabId, key, () => null) })),

  syncMissing: (tabId, presentObjectIds, upToGeneration) =>
    set((s) => {
      const tab = s.drafts[tabId];
      if (!tab) return s;
      let drafts = s.drafts;
      for (const draft of Object.values(tab)) {
        if (draft.mode !== "edit" || !draft.item) continue;
        if (upToGeneration !== undefined && draft.generation > upToGeneration) {
          continue;
        }
        const missing = !presentObjectIds.has(draft.item.id);
        if (missing && !hasPendingWork(draft)) {
          drafts = updateDraft(drafts, tabId, draft.key, () => null);
        } else if (missing !== draft.missing) {
          drafts = updateDraft(drafts, tabId, draft.key, (d) => ({
            ...d,
            missing,
          }));
        }
      }
      return drafts === s.drafts ? s : { drafts };
    }),

  clearTab: (tabId) =>
    set((s) => {
      if (!s.drafts[tabId]) return s;
      const { [tabId]: _removed, ...drafts } = s.drafts;
      return { drafts };
    }),

  clearAll: () => set({ drafts: {} }),
}));

/** The drafts of one connection screen tab. */
export function objectDraftsForTab(tabId: string): ObjectDraft[] {
  return Object.values(useObjectDraftStore.getState().drafts[tabId] ?? {});
}

/** Whether a connection screen tab has unsaved object work. */
export function tabHasPendingObjectWork(tabId: string): boolean {
  return objectDraftsForTab(tabId).some(hasPendingWork);
}

export function anyTabHasPendingObjectWork(): boolean {
  return Object.keys(useObjectDraftStore.getState().drafts).some(
    tabHasPendingObjectWork
  );
}
