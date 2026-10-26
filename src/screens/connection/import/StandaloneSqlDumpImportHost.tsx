import { useEffect, useRef } from "preact/hooks";
import { useScreenStore } from "src/stores/screen";
import { useDatabaseBackup } from "../hooks/useDatabaseBackup";
import type { StandaloneExportTarget } from "../export/standalone-export/types";
import { forgetImportedTableRows } from "./standaloneImport";

/**
 * "Import from SQL dump" started from the sidebar without opening the
 * table: the usual dump import (file, engine check, confirmation), with
 * the tab's Lock mode checked again right before anything runs. The
 * request is taken over at once, so coming back never starts it again.
 */
export function StandaloneSqlDumpImportHost(props: {
  profileScreenId: string;
  target: StandaloneExportTarget | null;
  onClearTarget: () => void;
}) {
  const { target, onClearTarget, profileScreenId } = props;
  const { onImportSqlDump } = useDatabaseBackup();
  const runningRef = useRef(false);

  useEffect(() => {
    if (!target) return;
    onClearTarget();
    // One dump import at a time; a request made meanwhile is dropped.
    if (runningRef.current) return;
    runningRef.current = true;
    const tabId = profileScreenId;
    const table = { schema: target.schema, name: target.tableName };
    void onImportSqlDump(() => forgetImportedTableRows(tabId, table), {
      canRun: () =>
        !(
          useScreenStore.getState().profileTabs.find((t) => t.id === tabId)
            ?.isLocked ?? false
        ),
    }).finally(() => {
      runningRef.current = false;
    });
    // Once per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.requestId]);

  return null;
}
