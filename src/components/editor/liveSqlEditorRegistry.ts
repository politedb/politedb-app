type LiveSqlEditorApi = {
  getValue: () => string;
  appendSql: (sql: string) => Promise<void>;
};

const MAX_APPEND_ATTEMPTS = 3;
const APPEND_RETRY_DELAY_MS = 40;

type PendingSql = {
  sql: string;
  attempts: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

type LiveSqlEditorEntry = {
  api?: LiveSqlEditorApi;
  pendingSql: PendingSql[];
  activePending?: PendingSql;
  draining: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
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
  if (entry.draining || entry.retryTimer || !entry.api) return;
  let failedApi: LiveSqlEditorApi | undefined;
  entry.draining = true;
  try {
    while (entry.api && entry.pendingSql.length > 0) {
      const pending = entry.pendingSql[0]!;
      const api: LiveSqlEditorApi = entry.api;
      entry.activePending = pending;
      try {
        await api.appendSql(pending.sql);
      } catch (error) {
        entry.activePending = undefined;
        if (entry.api !== api) {
          pending.attempts = 0;
          continue;
        }
        pending.attempts += 1;

        if (pending.attempts >= MAX_APPEND_ATTEMPTS) {
          entry.pendingSql.shift();
          pending.reject(
            error instanceof Error
              ? error
              : new Error(String(error ?? "Failed to insert SQL into editor."))
          );
          continue;
        }

        failedApi = api;
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = undefined;
          void drainPendingSql(windowId, entry);
        }, APPEND_RETRY_DELAY_MS * pending.attempts);
        return;
      }
      entry.activePending = undefined;
      const completedIndex = entry.pendingSql.indexOf(pending);
      if (completedIndex >= 0) entry.pendingSql.splice(completedIndex, 1);
      pending.resolve();
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
  const replacedApi = entry.api && entry.api !== api;
  entry.api = api;
  if (replacedApi) {
    entry.pendingSql.forEach((pending) => {
      pending.attempts = 0;
    });
  }
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  }
  void drainPendingSql(windowId, entry);

  return () => {
    if (entry.api !== api) return;
    entry.api = undefined;
    if (!entry.draining && entry.pendingSql.length === 0) {
      liveSqlEditors.delete(windowId);
    }
  };
}

export function enqueueSqlIntoLiveEditor(
  windowId: string,
  sql: string
): Promise<void> {
  const next = sql.trim();
  if (!next) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const entry = getOrCreateEntry(windowId);
    entry.pendingSql.push({ sql: next, attempts: 0, resolve, reject });
    void drainPendingSql(windowId, entry);
  });
}

export function consumeUndrainedSqlForLiveEditor(windowId: string) {
  const entry = liveSqlEditors.get(windowId);
  if (!entry) return [];
  const excludeActive = entry.api ? entry.activePending : undefined;
  const pending = entry.pendingSql
    .filter((item) => item !== excludeActive)
    .map((item) => {
      item.resolve();
      return item.sql;
    });
  entry.pendingSql = excludeActive ? [excludeActive] : [];
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  }
  if (!entry.api && !entry.draining) liveSqlEditors.delete(windowId);
  return pending;
}

export function getLiveSqlEditorContent(windowId: string): string | null {
  return liveSqlEditors.get(windowId)?.api?.getValue() ?? null;
}
