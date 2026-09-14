import { useMemo } from "preact/hooks";

import type { SqlEditorWindow, DatabaseEngine } from "src/types";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";

import { SplitPane } from "src/components/SplitPane";
import { SqlResultsPane } from "src/components/editor/SqlResultsPane";
import { Spinner } from "src/components/common/Spinner";
import { createRetryableLazy } from "src/components/common/RetryableLazy";
import { useSqlRunner } from "src/screens/connection/hooks/useSqlRunner";
import { RunSqlReturn } from "./hooks/useSqlHistoryRunner";
import type { QuerySafetyMode } from "@root/src/lib/queries/querySafety";

const loadSqlEditorPane = () =>
  import("src/components/editor/SqlEditorPane").then((module) => ({
    default: module.SqlEditorPane,
  }));

const SqlEditorPane = createRetryableLazy(loadSqlEditorPane, {
  label: "SQL editor",
  renderFallback: () => (
    <div class="flex h-full items-center justify-center">
      <Spinner className="text-blue-600" />
    </div>
  ),
});

function makeSqlWindowScopeId(metaKey: string, windowId: string) {
  return `${metaKey || "sql"}:${windowId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function SqlWindowPane(props: {
  win: SqlEditorWindow;
  engine: DatabaseEngine;
  metaKey: string;
  metadata: MetadataApi;
  runtimeConnectionId: string | undefined;
  isProfileLocked?: boolean;
  sqlSafetyMode?: QuerySafetyMode;
  sqlScopeKey?: string;
  onRunSql: (args: {
    windowId: string;
    connectionId: string;
    sql: string;
  }) => Promise<RunSqlReturn>;
}) {
  const {
    win,
    engine,
    metaKey,
    metadata,
    runtimeConnectionId,
    isProfileLocked = false,
    sqlSafetyMode = "default",
    sqlScopeKey,
    onRunSql,
  } = props;

  const meta = useMemo(() => {
    return metadata.get({
      metaKey,
      engine,
      connectionId: runtimeConnectionId,
      includeColumns: true,
      lazy: true,
    });
  }, [metadata, metaKey, engine, runtimeConnectionId]);

  const scopedWindowId = useMemo(
    () => makeSqlWindowScopeId(sqlScopeKey ?? metaKey, win.id),
    [metaKey, sqlScopeKey, win.id]
  );

  const {
    sqlRuns,
    activeRunId,
    setActiveRunId,
    activeResultIndex,
    setActiveResultIndex,
    startRun,
    startExplain,
    closeRun,
    cancelRun,
  } = useSqlRunner({
    activeSqlWindowId: scopedWindowId,
    runtimeConnectionId,
    engine,
    isProfileLocked,
    sqlSafetyMode,
    onRunSql,
  });

  const activeRun =
    sqlRuns.find((run) => run.id === activeRunId) ??
    sqlRuns[sqlRuns.length - 1] ??
    null;
  const isExecutingSql =
    activeRun?.slots.some(
      (slot) => slot.status === "queued" || slot.status === "running"
    ) ?? false;

  return (
    <div class="h-full min-h-0 overflow-hidden">
      <SplitPane
        direction="vertical"
        initialRatio={0.65}
        minFirstPx={180}
        minSecondPx={160}
        splitterPx={8}
        fixedPaneOnResize="second"
        first={
          <div class="h-full min-h-0">
            <SqlEditorPane
              win={win}
              schemas={meta.schemas}
              tables={meta.tables}
              columnsByTable={meta.columnsByTable}
              engine={engine}
              storageId={scopedWindowId}
              onRunSql={(payload) =>
                startRun({ windowId: scopedWindowId, sql: payload.sql })
              }
              onExplainSql={(payload) =>
                startExplain({ windowId: scopedWindowId, sql: payload.sql })
              }
              onCancelSql={() => {
                if (activeRun?.id) cancelRun(activeRun.id);
              }}
              isExecuting={isExecutingSql}
            />

            {!runtimeConnectionId ? (
              <div class="border-t border-neutral-200 bg-white px-3 py-2">
                <p class="text-xs text-neutral-500">
                  Connect to a profile to run SQL.
                </p>
              </div>
            ) : null}
          </div>
        }
        second={
          <SqlResultsPane
            engine={engine}
            windowId={scopedWindowId}
            runs={sqlRuns}
            activeRunId={activeRunId}
            setActiveRunId={setActiveRunId}
            activeIndex={activeResultIndex}
            setActiveIndex={setActiveResultIndex}
            onCloseRun={closeRun}
          />
        }
      />
    </div>
  );
}
