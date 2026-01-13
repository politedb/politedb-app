import { Box } from "src/components/common/Box";
import { Database } from "src/components/icons";
import { TableData } from "src/components/table/TableData";
import type {
  DatabaseEngine,
  OpenWindow,
  SqlEditorWindow,
  TableItem,
  TableWindow,
} from "src/types";
import { SqlEditorPane } from "src/components/editor/SqlEditorPane";
import { useMemo } from "preact/hooks";
import { SplitPane } from "src/components/SplitPane";
import type { QueryResult } from "src/lib/tauri";
import { SqlResultsPane } from "src/components/editor/SqlResultsPane";
import { useSqlRunner } from "src/screens/connection/hooks/useSqlRunner";

type ActiveTableData = {
  data: any;
  sizeInfo: any;
  busy: boolean;
  error: any;
};

type PatchMap = Record<string, Record<string, Record<string, any>>>;

function EmptyState(props: { onNewSql: () => void }) {
  return (
    <Box className="text-center">
      <Database className="mx-auto mb-4 size-12 text-neutral-300" />
      <p class="text-neutral-500">
        Select a table from the sidebar (or open SQL editor) to view data
      </p>
      <div class="mt-3">
        <button
          class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white"
          onClick={props.onNewSql}
        >
          New SQL Editor
        </button>
      </div>
    </Box>
  );
}

function ErrorState(props: { error: string }) {
  return (
    <Box className="text-center">
      <p class="text-sm text-red-500">{props.error}</p>
    </Box>
  );
}

function LoadingTableState() {
  return (
    <Box className="text-center">
      <div class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
      <p class="text-neutral-500">Loading table data...</p>
    </Box>
  );
}

function TableErrorState(props: { error: string }) {
  return (
    <Box className="text-center">
      <p class="mb-2 text-red-600">Error loading table data</p>
      <p class="text-sm text-neutral-500">{props.error}</p>
    </Box>
  );
}

export function ActiveWindowContent(props: {
  activeWindow?: OpenWindow;
  activeSqlWindow?: SqlEditorWindow;
  activeTableWindow?: TableWindow;

  activeTableData: ActiveTableData;

  loadError: string | null;
  hasAnyWindow: boolean;

  runtimeConnectionId: string | null;
  schemas: string[];
  tables: TableItem[];

  onNewSql: () => void;

  onRunSql: (args: {
    windowId: string;
    connectionId: string;
    sql: string;
  }) => Promise<QueryResult>;

  onCellChange: (rowIndex: number, columnIndex: number, value: any) => void;
  patchMap: PatchMap;
  engine: DatabaseEngine;
}) {
  const {
    activeWindow,
    activeSqlWindow,
    activeTableWindow,
    activeTableData,
    loadError,
    hasAnyWindow,
    runtimeConnectionId,
    schemas,
    tables,
    onNewSql,
    onRunSql,
    onCellChange,
    patchMap,
    engine,
  } = props;

  const tablePatches = useMemo(() => {
    if (!activeTableWindow) return null;
    return patchMap[activeTableWindow.id] ?? null;
  }, [patchMap, activeTableWindow?.id]);

  /* =========================
   * SQL runner hook
   * ========================= */
  const { sqlSlots, activeResultIndex, setActiveResultIndex, startRun } =
    useSqlRunner({
      activeSqlWindowId: activeSqlWindow?.id,
      runtimeConnectionId,
      onRunSql,
    });

  /* =========================
   * Columns autocomplete
   * ========================= */
  const columnsByTable = useMemo(() => {
    if (!activeTableWindow || !activeTableData?.data?.columns) return undefined;

    const k = `${activeTableWindow.table.schema}.${activeTableWindow.table.name}`;
    return {
      [k]: activeTableData.data.columns.map((c: any) => c.name).filter(Boolean),
    };
  }, [activeTableWindow, activeTableData?.data?.columns]);

  /* =========================
   * Global guards
   * ========================= */
  if (loadError) return <ErrorState error={loadError} />;
  if (!hasAnyWindow) return <EmptyState onNewSql={onNewSql} />;

  if (!activeWindow) {
    return (
      <Box>
        <p class="text-neutral-500">Select a tab to continue</p>
      </Box>
    );
  }

  /* =========================
   * SQL editor window
   * ========================= */
  if (activeSqlWindow) {
    return (
      <div class="h-full min-h-0 overflow-hidden">
        <SplitPane
          direction="vertical"
          initialRatio={0.45}
          minFirstPx={180}
          minSecondPx={160}
          splitterPx={8}
          first={
            <div class="h-full min-h-0">
              <SqlEditorPane
                win={activeSqlWindow}
                tables={tables}
                schemas={schemas}
                engine={engine}
                columnsByTable={columnsByTable}
                onRunSql={({ windowId, sql }) =>
                  void startRun({ windowId, sql })
                }
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
              windowId={activeSqlWindow.id}
              slots={sqlSlots}
              activeIndex={activeResultIndex}
              setActiveIndex={setActiveResultIndex}
            />
          }
        />
      </div>
    );
  }

  /* =========================
   * Table window
   * ========================= */
  if (!activeTableWindow) return null;
  if (activeTableData.busy) return <LoadingTableState />;

  if (activeTableData.error) {
    return <TableErrorState error={String(activeTableData.error)} />;
  }

  if (!activeTableData.data) return null;

  return (
    <TableData
      key={activeTableWindow.id}
      columns={activeTableData.data.columns}
      data={activeTableData.data.rows}
      onCellChange={onCellChange}
      patches={tablePatches}
    />
  );
}
