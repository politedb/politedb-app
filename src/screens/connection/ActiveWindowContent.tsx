import { Box } from "src/components/common/Box";
import { Database } from "src/components/icons";
import { TableData } from "src/components/table/TableData";
import type { OpenWindow, SqlEditorWindow, TableWindow } from "src/types";

type ActiveTableData = {
  data: any;
  sizeInfo: any;
  busy: boolean;
  error: any;
};

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
      <div class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600"></div>
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

  onNewSql: () => void;
  onCellChange: (rowIndex: number, columnIndex: number, value: any) => void;
}) {
  const {
    activeWindow,
    activeSqlWindow,
    activeTableWindow,
    activeTableData,
    loadError,
    hasAnyWindow,
    onNewSql,
    onCellChange,
  } = props;

  if (loadError) return <ErrorState error={loadError} />;
  if (!hasAnyWindow) return <EmptyState onNewSql={onNewSql} />;

  if (!activeWindow) {
    return (
      <Box>
        <p class="text-neutral-500">Select a tab to continue</p>
      </Box>
    );
  }

  // SQL window rendering (replace with your SqlEditor component)
  if (activeSqlWindow) {
    return (
      <Box>
        <p class="text-neutral-500">
          SQL Editor: {activeSqlWindow.title || "Untitled SQL"}
        </p>
        {/* TODO: render your editor here */}
      </Box>
    );
  }

  // Table window rendering
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
    />
  );
}
