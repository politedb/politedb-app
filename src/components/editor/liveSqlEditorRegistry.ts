type LiveSqlEditorApi = {
  getValue: () => string;
  appendSql: (sql: string) => Promise<void>;
};

type PendingSql = { sql: string };

type LiveSqlEditorEntry = {
  api?: LiveSqlEditorApi;
  pendingSql: PendingSql[];
  activePending?: PendingSql;
  draining: boolean;
};

const liveSqlEditors = new Map<string, LiveSqlEditorEntry>();

function getOrCreateEntry(windowId: string) {
  const existing = liveSqlEditors.get(windowId);
  if (existing) return existing;
  const entry: LiveSqlEditorEntry = { pendingSql: [], draining: false };
  liveSqlEditors.set(windowId, entry);
  return entry;
}

async function drainPendingSql(windowId: string, entry: LiveSqlEditorEntry) {
  if (entry.draining || !entry.api) return;
  let failedApi: LiveSqlEditorApi | undefined;
  entry.draining = true;
  try {
    while (entry.api && entry.pendingSql.length > 0) {
      const pending = entry.pendingSql[0]!;
      const api = entry.api;
      entry.activePending = pending;
      try {
        await api.appendSql(pending.sql);
      } catch {
        entry.activePending = undefined;
        failedApi = api;
        return;
      }
      entry.activePending = undefined;
      const completedIndex = entry.pendingSql.indexOf(pending);
      if (completedIndex >= 0) entry.pendingSql.splice(completedIndex, 1);
    }
  } finally {
    entry.draining = false;
    if (!entry.api && entry.pendingSql.length === 0) {
      liveSqlEditors.delete(windowId);
    } else if (
      entry.api &&
      entry.api !== failedApi &&
      entry.pendingSql.length > 0
    ) {
      void drainPendingSql(windowId, entry);
    }
  }
}

export function registerLiveSqlEditor(windowId: string, api: LiveSqlEditorApi) {
  const entry = getOrCreateEntry(windowId);
  entry.api = api;
  void drainPendingSql(windowId, entry);

  return () => {
    if (entry.api !== api) return;
    entry.api = undefined;
    if (!entry.draining && entry.pendingSql.length === 0) {
      liveSqlEditors.delete(windowId);
    }
  };
}

export function enqueueSqlIntoLiveEditor(windowId: string, sql: string) {
  const next = sql.trim();
  if (!next) return;
  const entry = getOrCreateEntry(windowId);
  entry.pendingSql.push({ sql: next });
  void drainPendingSql(windowId, entry);
}

export function consumeUndrainedSqlForLiveEditor(windowId: string) {
  const entry = liveSqlEditors.get(windowId);
  if (!entry) return [];
  const excludeActive = entry.api ? entry.activePending : undefined;
  const pending = entry.pendingSql
    .filter((item) => item !== excludeActive)
    .map((item) => item.sql);
  entry.pendingSql.length = 0;
  if (!entry.api && !entry.draining) liveSqlEditors.delete(windowId);
  return pending;
}

export function getLiveSqlEditorContent(windowId: string): string | null {
  return liveSqlEditors.get(windowId)?.api?.getValue() ?? null;
}
