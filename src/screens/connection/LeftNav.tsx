import { SetStateAction } from "preact/compat";
import { Dispatch, useState } from "preact/hooks";
import { ChevronDown, ChevronRight, Search, Table } from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import { NewTableMenu } from "src/components/table/NewTableMenu";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import { cn } from "src/utils/cn";
import type { TableItem } from "src/types";
import { useMiddleEllipsisByWidth } from "src/hooks/useMiddleEllipsisByWidth";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useConnectionStore } from "src/stores/connection";
import { useConnectionWindows } from "./hooks/useConnectionWindows";

interface Props {
  profileId: string;
  schemas: string[];
  currSchema: string;
  onSchemaChange: (schema: string) => void;

  tableSearchQuery: string;
  setTableSearchQuery: Dispatch<SetStateAction<string>>;

  expandedSections: { functions: boolean; tables: boolean };
  setExpandedSections: Dispatch<
    SetStateAction<{ functions: boolean; tables: boolean }>
  >;

  filteredTables: TableItem[];
  activeWindowId: string | null;
}

function SectionHeader(props: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { title, expanded, onToggle } = props;

  return (
    <Button
      variant="ghost"
      onClick={onToggle}
      className={cn("w-full px-2 py-1.5 hover:bg-neutral-200/60")}
      title={title}
    >
      <div class="flex w-full items-center justify-start gap-1">
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-neutral-500" />
        )}

        <span class="min-w-0 truncate text-start text-sm font-semibold tracking-wide text-neutral-600">
          {title}
        </span>
      </div>
    </Button>
  );
}

function TableName({ name }: { name: string }) {
  const { ref, value } = useMiddleEllipsisByWidth({ text: name });
  return (
    <span
      ref={ref}
      class="min-w-0 flex-1 overflow-hidden text-ellipsis select-none"
    >
      {value}
    </span>
  );
}

export function LeftNav({
  profileId,
  schemas,
  currSchema,
  onSchemaChange,
  tableSearchQuery,
  setTableSearchQuery,
  expandedSections,
  setExpandedSections,
  filteredTables,
  activeWindowId,
}: Props) {
  const actions = useConnectionActionsCtx();
  const { dataPatchMap } = useConnectionStore();
  const { windowHasPatchChanges } = useConnectionWindows(profileId);

  const [tableMenu, setTableMenu] = useState<{
    x: number;
    y: number;
    table: TableItem;
  } | null>(null);

  const tableMenuItems: MenuItem[] = tableMenu
    ? [
        {
          type: "item",
          label: "Open table",
          onClick: () => {
            void actions.selectTable(tableMenu.table);
          },
        },
        {
          type: "item",
          label: "Copy name",
          onClick: () => navigator.clipboard.writeText(tableMenu.table.name),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Export data",
          onClick: () => actions.exportTableData(tableMenu.table),
        },
        {
          type: "item",
          label: "Import data from CSV",
          onClick: () => actions.importTableData(tableMenu.table),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Clone...",
          onClick: () => actions.cloneTable(tableMenu.table),
        },
        {
          type: "item",
          label: "Truncate...",
          onClick: () => actions.truncateTable(tableMenu.table),
        },
        {
          type: "item",
          label: "Drop...",
          onClick: () => actions.dropTable(tableMenu.table),
        },
      ]
    : [];

  return (
    <aside
      class={cn(
        "flex h-full w-full flex-col",
        "border-r border-neutral-200 bg-neutral-100"
      )}
    >
      {/* Top: Search */}
      <div class="p-2">
        <div class="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            placeholder="Search tables…"
            value={tableSearchQuery}
            onInput={(e: any) => setTableSearchQuery(e.currentTarget.value)}
            class={cn(
              "w-full rounded-lg",
              "border border-neutral-200 bg-white",
              "py-1.5 pr-2 pl-8",
              "text-xs text-neutral-800 placeholder:text-neutral-500",
              "outline-none",
              "focus:border-neutral-300 focus:ring-2 focus:ring-black/5"
            )}
          />
        </div>
      </div>

      {/* Middle: Sections */}
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        {/* Functions */}
        <div class="mb-2">
          <SectionHeader
            title="Functions"
            expanded={expandedSections.functions}
            onToggle={() =>
              setExpandedSections((prev) => ({
                ...prev,
                functions: !prev.functions,
              }))
            }
          />

          {expandedSections.functions && (
            <div class="mt-1 rounded-lg bg-white/60 p-2 text-xs text-neutral-500"></div>
          )}
        </div>

        {/* Tables */}
        <div>
          <SectionHeader
            title="Tables"
            expanded={expandedSections.tables}
            onToggle={() =>
              setExpandedSections((prev) => ({
                ...prev,
                tables: !prev.tables,
              }))
            }
          />

          {expandedSections.tables && (
            <div class="mt-1">
              {filteredTables.length === 0 ? (
                <div class="rounded-lg bg-white/60 px-3 py-2 text-xs text-neutral-500">
                  No tables found
                </div>
              ) : (
                <div class="space-y-1 pl-3">
                  {filteredTables.map((table) => {
                    const key = `${table.schema}.${table.name}`;
                    const isActive = activeWindowId === `table:${key}`;
                    const hasChanges = windowHasPatchChanges(
                      dataPatchMap[profileId]?.[`table:${key}`]
                    );

                    return (
                      <Button
                        variant={isActive ? "default" : "ghost"}
                        key={key}
                        onClick={() => void actions.selectTable(table)}
                        onContextMenu={(e: MouseEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setTableMenu({ x: e.clientX, y: e.clientY, table });
                        }}
                        active={isActive}
                        className={cn(
                          "w-full justify-start",
                          "rounded-md px-2.5 py-1.5",
                          "gap-2",
                          "text-left text-sm",
                          "overflow-hidden text-ellipsis select-none",
                          "transition-none",
                          !isActive && "hover:bg-neutral-200/60",
                          hasChanges
                            ? "bg-amber-100 text-neutral-600 hover:bg-amber-100/80"
                            : ""
                        )}
                        title={key}
                      >
                        <Table
                          className={cn(
                            "size-4 shrink-0",
                            isActive && !hasChanges
                              ? "text-white"
                              : "text-neutral-500"
                          )}
                        />
                        <TableName name={table.name} />
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ContextMenu
        open={!!tableMenu}
        x={tableMenu?.x ?? 0}
        y={tableMenu?.y ?? 0}
        items={tableMenuItems}
        onClose={() => setTableMenu(null)}
      />

      {/* Bottom: Toolbar */}
      <div class="border-t border-neutral-200 bg-neutral-100 p-2">
        <div class="flex items-center gap-2">
          <NewTableMenu
            onOpenNewTable={() => {
              const t: TableItem = {
                schema: currSchema,
                name: `untitled_table_${Math.round(Date.now() / 1000)}`,
                new: true,
              } as TableItem;

              void actions.selectTable(t);
            }}
          />

          <Select
            className={cn(
              "h-8 w-full rounded-lg border-neutral-300 bg-white",
              "text-xs! font-medium! text-neutral-800",
              "focus:border-neutral-300 focus:ring-2 focus:ring-black/5"
            )}
            defaultValue={currSchema}
            onChange={(e) => onSchemaChange(e.currentTarget.value)}
          >
            {schemas.map((schema) => (
              <option value={schema}>{schema}</option>
            ))}
          </Select>
        </div>
      </div>
    </aside>
  );
}
