type LiveSqlEditorApi = {
  getValue: () => string;
  appendSql: (sql: string) => Promise<void>;
};

const liveSqlEditors = new Map<string, LiveSqlEditorApi>();

export function registerLiveSqlEditor(windowId: string, api: LiveSqlEditorApi) {
  liveSqlEditors.set(windowId, api);
}

export function unregisterLiveSqlEditor(windowId: string) {
  liveSqlEditors.delete(windowId);
}

export function getLiveSqlEditorContent(windowId: string): string | null {
  return liveSqlEditors.get(windowId)?.getValue() ?? null;
}

export async function appendSqlIntoLiveEditor(
  windowId: string,
  sql: string
): Promise<boolean> {
  const api = liveSqlEditors.get(windowId);
  if (!api) return false;
  await api.appendSql(sql);
  return true;
}
