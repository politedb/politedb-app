import { useMemo } from "preact/hooks";

import type { SqlEditorWindow, DatabaseEngine } from "src/types";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";

import { SplitPane } from "src/components/SplitPane";
import { SqlEditorPane } from "src/components/editor/SqlEditorPane";
import { SqlResultsPane } from "src/components/editor/SqlResultsPane";
import { useSqlRunner } from "src/screens/connection/hooks/useSqlRunner";
import { RunSqlReturn } from "./hooks/useSqlHistoryRunner";

export function SqlWindowPane(props: {
  win: SqlEditorWindow;
  engine: DatabaseEngine;
  metaKey: string;
  metadata: MetadataApi;
  runtimeConnectionId: string | undefined;
  isProfileLocked?: boolean;
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
    onRunSql,
  } = props;

  const meta = useMemo(() => {
    return metadata.get({
      metaKey,
      engine,
      connectionId: runtimeConnectionId,
      lazy: true,
    });
  }, [metadata, metaKey, engine, runtimeConnectionId]);

  const { sqlSlots, activeResultIndex, setActiveResultIndex, startRun } =
    useSqlRunner({
      activeSqlWindowId: win.id,
      runtimeConnectionId,
      isProfileLocked,
      onRunSql,
    });

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
              onRunSql={({ windowId, sql }) => startRun({ windowId, sql })}
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
            windowId={win.id}
            slots={sqlSlots}
            activeIndex={activeResultIndex}
            setActiveIndex={setActiveResultIndex}
          />
        }
      />
    </div>
  );
}
