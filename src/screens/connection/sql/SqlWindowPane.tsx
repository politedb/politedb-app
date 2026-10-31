import { useMemo } from "preact/hooks";

import type { SqlEditorWindow, DatabaseEngine } from "src/types";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";

import { SplitPane } from "src/components/SplitPane";
import { SqlResultsPane } from "src/components/editor/SqlResultsPane";
import { Spinner } from "src/components/common/Spinner";
import { createRetryableLazy } from "src/components/common/RetryableLazy";
import { useSqlRunner } from "src/screens/connection/hooks/useSqlRunner";
import type {
  RunSqlReturn,
  SqlHistoryTarget,
} from "../hooks/useSqlHistoryRunner";
import type { QuerySafetyMode } from "@root/src/lib/queries/querySafety";
import {
  explainModeFor,
  supportsExplainAnalyze,
} from "src/lib/sql/analyzeClassify";
import { useProGate } from "src/hooks/useProGate";
import { parseSqlErrorPosition } from "src/lib/sql/errorPosition";

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
  /** The schema picked for the connection: unqualified names resolve there. */
  activeSchema?: string;
  metaKey: string;
  metadata: MetadataApi;
  runtimeConnectionId: string | undefined;
  /** The connection tab the editor belongs to (D3). */
  tabId?: string;
  isProfileLocked?: boolean;
  sqlSafetyMode?: QuerySafetyMode;
  sqlScopeKey?: string;
  onRunSql: (args: {
    windowId: string;
    connectionId: string;
    sql: string;
  }) => Promise<RunSqlReturn>;
  captureHistoryTarget?: () => SqlHistoryTarget | null;
}) {
  const {
    win,
    engine,
    activeSchema,
    metaKey,
    metadata,
    runtimeConnectionId,
    tabId,
    isProfileLocked = false,
    sqlSafetyMode = "default",
    sqlScopeKey,
    onRunSql,
    captureHistoryTarget,
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
    startExplainAnalyze,
    closeRun,
    closeSlot,
    cancelRun,
  } = useSqlRunner({
    activeSqlWindowId: scopedWindowId,
    runtimeConnectionId,
    tabId,
    engine,
    isProfileLocked,
    sqlSafetyMode,
    onRunSql,
    captureHistoryTarget,
  });
  // Pro on PostgreSQL: Explain measures (Explain Analyze); statements it
  // can't measure get the estimated plan.
  const { hasPro } = useProGate();
  const canExplainAnalyze = hasPro && supportsExplainAnalyze(engine);

  const activeRun =
    sqlRuns.find((run) => run.id === activeRunId) ??
    sqlRuns[sqlRuns.length - 1] ??
    null;
  const isExecutingSql =
    activeRun?.slots.some(
      (slot) => slot.status === "queued" || slot.status === "running"
    ) ?? false;

  // The error of the statement on screen, where it points inside it.
  const shownSlot = activeRun?.slots[activeResultIndex] ?? activeRun?.slots[0];
  // Explain runs report positions in the wrapped statement: not underlined.
  const errorPosition =
    activeRun?.kind === "query" && shownSlot?.status === "error"
      ? parseSqlErrorPosition(shownSlot.error)
      : null;
  const errorMarker =
    shownSlot && errorPosition && activeRun?.sourceKey
      ? {
          runKey: activeRun!.sourceKey ?? "",
          runSql: activeRun!.sql,
          statementIndex: shownSlot.index,
          ...errorPosition,
          message: (shownSlot.error ?? "")
            .split("\n")
            .filter((line) => line.startsWith("ERROR:"))
            .join("\n"),
        }
      : null;

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
              activeSchema={activeSchema}
              tables={meta.tables}
              columnsByTable={meta.columnsByTable}
              engine={engine}
              storageId={scopedWindowId}
              onRunSql={(payload) =>
                startRun({
                  windowId: scopedWindowId,
                  sql: payload.sql,
                  sourceKey: payload.sourceKey,
                })
              }
              onExplainSql={(payload) =>
                startExplain({ windowId: scopedWindowId, sql: payload.sql })
              }
              onExplainAnalyzeSql={
                canExplainAnalyze
                  ? (payload) =>
                      explainModeFor(payload.sql) === "analyze"
                        ? startExplainAnalyze({
                            windowId: scopedWindowId,
                            sql: payload.sql,
                            sourceUnchanged: payload.sourceUnchanged,
                          })
                        : startExplain({
                            windowId: scopedWindowId,
                            sql: payload.sql,
                          })
                  : undefined
              }
              onCancelSql={() => {
                if (activeRun?.id) cancelRun(activeRun.id);
              }}
              isExecuting={isExecutingSql}
              errorMarker={errorMarker}
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
            onCloseSlot={closeSlot}
            onRunAnalyze={
              canExplainAnalyze
                ? (origin) =>
                    startExplainAnalyze({
                      windowId: scopedWindowId,
                      sql: origin.sql,
                      origin: { connectionId: origin.connectionId },
                    })
                : undefined
            }
          />
        }
      />
    </div>
  );
}
