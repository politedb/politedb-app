import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Box } from "src/components/common/Box";
import { Input } from "src/components/common/Input";
import { TableSizeInfo, DatabaseEngine, TableItem } from "src/types";
import type { SelectedRowDetail } from "src/stores/connection";
import { useConnectionStore } from "src/stores/connection";
import { AiAssistantPanel } from "src/components/ai-assistant/AiAssistantPanel";
import { cn } from "src/utils/cn";

interface Props {
  chatSessionKey: string;
  activeTab: "ai" | "table-size";
  onTabChange: (tab: "ai" | "table-size") => void;
  sizeInfo: TableSizeInfo | null;
  selectedRowDetail: SelectedRowDetail | null;
  tableLoadKey: string | null;
  dataReadOnly?: boolean;
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

function EditableRowFieldList({
  rowIndex,
  fields,
  readOnly,
  tableLoadKey,
}: {
  rowIndex: number;
  fields: SelectedRowDetail["fields"];
  readOnly?: boolean;
  tableLoadKey: string | null;
}) {
  const commitField = useConnectionStore((s) =>
    tableLoadKey ? s.rowFieldEditHandlerByKey[tableLoadKey] : undefined
  );

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef<Record<string, string>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const field of fields) {
      next[field.name] = field.isNull ? "" : field.value;
    }
    draftsRef.current = next;
    setDrafts(next);
  }, [fields, rowIndex]);

  const commit = useCallback(
    (name: string, value?: string) => {
      if (readOnly || !commitField) return;

      const field = fields.find((f) => f.name === name);
      if (field?.readonly) return;

      const draft = value ?? draftsRef.current[name] ?? "";
      const prevDisplay = field?.isNull ? "" : (field?.value ?? "");
      if (draft.trim() === prevDisplay.trim()) return;

      commitField(rowIndex, name, draft);
    },
    [readOnly, commitField, fields, rowIndex]
  );

  const commitAllDirty = useCallback(() => {
    for (const field of fields) {
      if (field.readonly) continue;
      commit(field.name);
    }
  }, [fields, commit]);

  // Canvas/table clicks may not blur sidebar inputs — flush on outside pointerdown.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = panelRef.current;
      if (!root || root.contains(e.target as Node)) return;
      commitAllDirty();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [commitAllDirty]);

  return (
    <div ref={panelRef} class="space-y-2 border-t border-neutral-100 pt-3">
      {fields.map((field) => {
        const fieldReadOnly = readOnly || field.readonly;
        const draft = drafts[field.name] ?? "";

        return (
          <div key={field.name} class="space-y-1 rounded-md">
            <div class="flex items-baseline justify-between gap-2">
              <div class="text-xs font-medium text-neutral-500">
                {field.name}
              </div>
              {field.dataType ? (
                <div class="shrink-0 text-[10px] text-neutral-400">
                  {field.dataType}
                </div>
              ) : null}
            </div>
            {fieldReadOnly ? (
              <div class="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-sm break-all text-neutral-900">
                {field.isNull && !draft.trim() ? (
                  <span class="text-neutral-400 italic">NULL</span>
                ) : (
                  draft
                )}
              </div>
            ) : (
              <Input
                className="text-sm"
                value={draft}
                placeholder={field.isNull ? "NULL" : undefined}
                onValueChange={(value) =>
                  setDrafts((prev) => {
                    const next = { ...prev, [field.name]: value };
                    draftsRef.current = next;
                    return next;
                  })
                }
                onBlur={(e) =>
                  commit(
                    field.name,
                    (e.currentTarget as HTMLInputElement).value
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function TableSizeSection({ sizeInfo }: { sizeInfo: TableSizeInfo }) {
  return (
    <div class="space-y-2 border-t border-neutral-100 pt-3">
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

function DataInfoPane({
  sizeInfo,
  selectedRowDetail,
  tableLoadKey,
  dataReadOnly,
}: {
  sizeInfo: TableSizeInfo | null;
  selectedRowDetail: SelectedRowDetail | null;
  tableLoadKey: string | null;
  dataReadOnly?: boolean;
}) {
  const hasRow = !!selectedRowDetail?.fields.length;

  if (!hasRow && !sizeInfo) {
    return (
      <Box className="p-4 text-center">
        <p class="text-sm text-neutral-500">No table selected</p>
      </Box>
    );
  }

  if (!hasRow) {
    return (
      <div class="flex h-full flex-col gap-2 overflow-y-auto bg-white px-3 py-2">
        <p class="text-xs text-neutral-500">
          Select a row in the table to view column values.
        </p>
        {sizeInfo ? <TableSizeSection sizeInfo={sizeInfo} /> : null}
      </div>
    );
  }

  return (
    <div class="flex h-full flex-col gap-2 overflow-y-auto bg-white px-3 py-2">
      <p class="text-xs text-neutral-500">Row data for selected row.</p>
      <EditableRowFieldList
        rowIndex={selectedRowDetail.rowIndex}
        fields={selectedRowDetail.fields}
        readOnly={dataReadOnly}
        tableLoadKey={tableLoadKey}
      />
    </div>
  );
}

export function RightNav({
  chatSessionKey,
  activeTab,
  onTabChange,
  sizeInfo,
  selectedRowDetail,
  tableLoadKey,
  dataReadOnly,
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
            chatSessionKey={chatSessionKey}
            engine={engine}
            runtimeConnectionId={runtimeConnectionId}
            activeSchema={activeSchema}
            tables={tables}
            columnsByTable={columnsByTable}
            currentSql={currentSql}
            onInsertSql={onInsertSql}
          />
        ) : (
          <DataInfoPane
            sizeInfo={sizeInfo}
            selectedRowDetail={selectedRowDetail}
            tableLoadKey={tableLoadKey}
            dataReadOnly={dataReadOnly}
          />
        )}
      </div>
    </div>
  );
}
