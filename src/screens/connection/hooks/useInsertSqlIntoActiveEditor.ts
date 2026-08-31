import { useCallback } from "preact/hooks";
import type { SqlEditorWindow } from "src/types";
import { enqueueSqlIntoLiveEditor } from "src/components/editor/liveSqlEditorRegistry";

export function useInsertSqlIntoActiveEditor(args: {
  activeSqlWindow: SqlEditorWindow | undefined;
  openSqlEditor: () => string | undefined;
}) {
  const { activeSqlWindow, openSqlEditor } = args;

  return useCallback(
    (sql: string) => {
      const next = sql.trim();
      if (!next) return;

      const targetWindowId = activeSqlWindow?.id ?? openSqlEditor();
      if (!targetWindowId) return;
      enqueueSqlIntoLiveEditor(targetWindowId, next);
    },
    [activeSqlWindow?.id, openSqlEditor]
  );
}
