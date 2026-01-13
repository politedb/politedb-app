import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

/**
 * Load SQL draft by windowId
 * @returns string | null (null = no draft)
 */
export async function loadSqlDraft(windowId: string): Promise<string | null> {
  if (!windowId) return null;

  try {
    const res = await invoke<string | null>(CMD.draftSqlLoad, {
      windowId,
    });
    return res ?? null;
  } catch (err) {
    console.warn("[sql-draft] load failed:", err);
    return null;
  }
}

/**
 * Save SQL draft (debounced from editor)
 */
export async function saveSqlDraft(
  windowId: string,
  content: string
): Promise<void> {
  if (!windowId) return;

  try {
    await invoke<void>(CMD.draftSqlSave, {
      windowId,
      content,
    });
  } catch (err) {
    console.warn("[sql-draft] save failed:", err);
  }
}

/**
 * Clear SQL draft (when SQL window is closed)
 */
export async function clearSqlDraft(windowId: string): Promise<void> {
  if (!windowId) return;

  try {
    await invoke<void>(CMD.draftSqlClear, {
      windowId,
    });
  } catch (err) {
    console.warn("[sql-draft] clear failed:", err);
  }
}

export type SqlDraftGcResult = { deleted: number; kept: number };

export async function gcSqlDrafts(opts?: {
  ttlDays?: number;
  maxFiles?: number;
}) {
  const ttlDays = opts?.ttlDays ?? 14;
  const maxFiles = opts?.maxFiles ?? 200;

  try {
    return await invoke<SqlDraftGcResult>(CMD.draftSqlGC, {
      ttlDays,
      maxFiles,
    });
  } catch (err) {
    console.warn("[sql-draft] gc failed:", err);
    return { deleted: 0, kept: 0 };
  }
}
