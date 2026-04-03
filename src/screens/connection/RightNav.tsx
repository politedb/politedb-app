import { Box } from "src/components/common/Box";
import { TableSizeInfo, DatabaseEngine, TableItem } from "src/types";
import { AiAssistantPanel } from "src/components/ai-assistant/AiAssistantPanel";
import { cn } from "src/utils/cn";

interface Props {
  activeTab: "ai" | "table-size";
  onTabChange: (tab: "ai" | "table-size") => void;
  sizeInfo: TableSizeInfo | null;
  engine: DatabaseEngine;
  runtimeConnectionId?: string;
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  currentSql?: string;
  onInsertSql?: (sql: string) => Promise<void> | void;
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: preact.ComponentChildren;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={cn(
        "rounded-md px-2 py-1 text-xs font-medium transition-colors",
        props.active
          ? "bg-blue-600 text-white"
          : "text-neutral-600 hover:bg-neutral-100"
      )}
    >
      {props.children}
    </button>
  );
}

function TableSizePane({ sizeInfo }: { sizeInfo: TableSizeInfo | null }) {
  if (!sizeInfo) {
    return (
      <Box className="p-4 text-center">
        <p class="text-sm text-neutral-500">No table selected</p>
      </Box>
    );
  }

  return (
    <div class="flex h-full flex-col gap-2 overflow-y-auto bg-white px-3 py-2">
      <div class="space-y-1 rounded-md">
        <div class="mb-1 text-xs font-medium text-neutral-500">Total Size</div>
        <div class="rounded-md border border-neutral-200 px-2 py-1 text-sm font-semibold capitalize">
          {sizeInfo.totalSize || "0 KB"}
        </div>
      </div>
      <div class="space-y-1 rounded-md">
        <div class="mb-1 text-xs font-medium text-neutral-500">Data Size</div>
        <div class="rounded-md border border-neutral-200 px-2 py-1 text-sm font-semibold capitalize">
          {sizeInfo.dataSize || "0 KB"}
        </div>
      </div>
      <div class="space-y-1 rounded-md">
        <div class="mb-1 text-xs font-medium text-neutral-500">
          Indexes Size
        </div>
        <div class="rounded-md border border-neutral-200 px-2 py-1 text-sm font-semibold capitalize">
          {sizeInfo.indexSize || "0 KB"}
        </div>
      </div>
    </div>
  );
}

export function RightNav({
  activeTab,
  onTabChange,
  sizeInfo,
  engine,
  runtimeConnectionId,
  activeSchema,
  tables,
  columnsByTable,
  currentSql,
  onInsertSql,
}: Props) {
  return (
    <div class="flex h-full min-h-0 flex-col bg-white">
      <div class="shrink-0 border-b border-neutral-200 px-2 py-2">
        <div class="flex items-center justify-center gap-1">
          <TabButton
            active={activeTab === "table-size"}
            onClick={() => onTabChange("table-size")}
          >
            Data Info
          </TabButton>
          <TabButton
            active={activeTab === "ai"}
            onClick={() => onTabChange("ai")}
          >
            AI Assistant
          </TabButton>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-hidden">
        {activeTab === "ai" ? (
          <AiAssistantPanel
            engine={engine}
            runtimeConnectionId={runtimeConnectionId}
            activeSchema={activeSchema}
            tables={tables}
            columnsByTable={columnsByTable}
            currentSql={currentSql}
            onInsertSql={onInsertSql}
          />
        ) : (
          <TableSizePane sizeInfo={sizeInfo} />
        )}
      </div>
    </div>
  );
}
