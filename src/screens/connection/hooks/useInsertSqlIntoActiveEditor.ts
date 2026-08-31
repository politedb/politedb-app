import { useCallback } from "preact/hooks";
import type { SqlEditorWindow } from "src/types";
import {
  appendSqlIntoLiveEditor,
  getLiveSqlEditorContent,
} from "src/components/editor/liveSqlEditorRegistry";
import { useScreenStore } from "src/stores/screen";

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function useInsertSqlIntoActiveEditor(args: {
  activeProfileScreen: string;
  activeSqlWindow: SqlEditorWindow | undefined;
  openSqlEditor: () => string | undefined;
}) {
  const { activeProfileScreen, activeSqlWindow, openSqlEditor } = args;

  return useCallback(
    async (sql: string) => {
      const next = sql.trim();
      if (!next) return;

      let targetWindowId = activeSqlWindow?.id;
      let current =
        (targetWindowId
          ? getLiveSqlEditorContent(targetWindowId)
          : null
        )?.trim() ??
        activeSqlWindow?.content?.trim() ??
        "";
      let title = activeSqlWindow?.title ?? "SQL Query";

      if (!targetWindowId) {
        targetWindowId = openSqlEditor();
      }

      if (!activeSqlWindow && targetWindowId) {
        const windows =
          useScreenStore.getState().openWindows[activeProfileScreen] ?? [];
        const createdWindow = windows.find(
          (window) => window.id === targetWindowId && window.type === "sql"
        );
        if (createdWindow?.type === "sql") {
          current = createdWindow.content?.trim() ?? "";
          title = createdWindow.title ?? "SQL Query";
        }
      }

      if (!targetWindowId) return;

      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (await appendSqlIntoLiveEditor(targetWindowId, next)) {
          return;
        }
        await sleep(50);
      }

      const merged = current ? `${current}\n\n${next}` : next;
      useScreenStore
        .getState()
        .updateSqlWindowContent(activeProfileScreen, targetWindowId, {
          content: merged,
          title,
        });

      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (await appendSqlIntoLiveEditor(targetWindowId, next)) {
          return;
        }
        await sleep(50);
      }
    },
    [activeProfileScreen, activeSqlWindow, openSqlEditor]
  );
}
