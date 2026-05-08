import { SetStateAction } from "preact/compat";
import { Dispatch, useState } from "preact/hooks";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  KeyIcon,
  SquareFunctionIcon,
  SearchIcon,
  TableIcon,
} from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import { NewTableMenu } from "src/components/table/NewTableMenu";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import { DeleteRedisKeyDialog } from "src/components/modal/DeleteRedisKeyDialog";
import { RenameRedisKeyDialog } from "src/components/modal/RenameRedisKeyDialog";
import { cn } from "src/utils/cn";
import type { DatabaseEngine, TableItem } from "src/types";
import { useMiddleEllipsisByWidth } from "src/hooks/useMiddleEllipsisByWidth";
import type { FunctionItem } from "src/hooks/useDatabaseMetadata";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { Input } from "src/components/common/Input";

interface Props {
  engine?: DatabaseEngine;
  profileId: string;
  schemas: string[];
  currSchema: string;
  onSchemaChange: (schema: string) => void;
  /** e.g. "Database" for Mongo, "Schema" for SQL engines */
  schemaLabel?: string;
  /** e.g. "Collections" for Mongo, "Tables" for SQL engines */
  tablesSectionTitle?: string;

  tableSearchQuery: string;
  setTableSearchQuery: Dispatch<SetStateAction<string>>;

  expandedSections: { functions: boolean; tables: boolean };
  setExpandedSections: Dispatch<
    SetStateAction<{ functions: boolean; tables: boolean }>
  >;

  filteredTables: TableItem[];
  filteredFunctions: FunctionItem[];
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
          <ChevronDownIcon className="size-3.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-neutral-500" />
        )}

        <span class="min-w-0 truncate text-start text-sm font-semibold tracking-wide text-neutral-600">
          {title}
        </span>
      </div>
    </Button>
  );
}

function TableName({ className, name }: { className?: string; name: string }) {
  const { ref, value } = useMiddleEllipsisByWidth({ text: name });
  return (
    <span
      ref={ref}
      class={cn(
        "min-w-0 flex-1 overflow-hidden text-ellipsis select-none",
        className
      )}
    >
      {value}
    </span>
  );
}

function EmptyItemsState(props: {
  isMongo: boolean;
  isRedis: boolean;
  hasSearch: boolean;
}) {
  const { isMongo, isRedis, hasSearch } = props;

  const icon = isRedis ? (
    <KeyIcon className="size-4 text-amber-500" />
  ) : (
    <TableIcon className="size-4 text-blue-500" />
  );

  const title = hasSearch
    ? isRedis
      ? "No matching keys"
      : isMongo
        ? "No matching collections"
        : "No matching tables"
    : isRedis
      ? "No keys yet"
      : isMongo
        ? "No collections found"
        : "No tables found";

  const description = hasSearch
    ? "Try a different search keyword."
    : isRedis
      ? "This Redis database does not have any keys right now."
      : isMongo
        ? "This database does not contain any collections yet."
        : "This schema does not contain any tables yet.";

  return (
    <div class="rounded-xl border border-dashed border-neutral-200 bg-white/80 px-3 py-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
      <div class="mx-auto mb-2 flex size-8 items-center justify-center rounded-full bg-neutral-100">
        {icon}
      </div>
      <div class="text-sm font-medium text-neutral-700">{title}</div>
      <div class="mt-1 text-xs leading-5 text-neutral-500">{description}</div>
    </div>
  );
}

export function LeftNav({
  engine,
  profileId,
  schemas,
  currSchema,
  onSchemaChange,
  schemaLabel = "Schema",
  tablesSectionTitle = "Tables",
  tableSearchQuery,
  setTableSearchQuery,
  expandedSections,
  setExpandedSections,
  filteredTables,
  filteredFunctions,
  activeWindowId,
}: Props) {
  const actions = useConnectionActionsCtx();
  const { dataPatchMap } = useConnectionStore();
  const isProfileLocked = useScreenStore(
    (s) => s.profileTabs.find((t) => t.id === profileId)?.isLocked ?? false
  );
  const { windowHasPatchChanges } = useConnectionWindows(profileId);
  const isMongo = engine === "mongo";
  const isRedis = engine === "redis";
  const supportsTableMutations = !isMongo && !isRedis;

  const [tableMenu, setTableMenu] = useState<{
    x: number;
    y: number;
    table: TableItem;
  } | null>(null);
  const [deleteRedisKeyTarget, setDeleteRedisKeyTarget] =
    useState<TableItem | null>(null);
  const [renameRedisKeyTarget, setRenameRedisKeyTarget] =
    useState<TableItem | null>(null);

  const tableMenuItems: MenuItem[] = tableMenu
    ? isRedis
      ? [
          {
            type: "item",
            label: "Copy name",
            onClick: () => navigator.clipboard.writeText(tableMenu.table.name),
          },
          { type: "sep" },
          {
            type: "item",
            label: "Rename key",
            disabled: isProfileLocked,
            onClick: () => setRenameRedisKeyTarget(tableMenu.table),
          },
          {
            type: "item",
            color: "red",
            label: "Delete key",
            disabled: isProfileLocked,
            onClick: () => setDeleteRedisKeyTarget(tableMenu.table),
          },
        ]
      : [
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
            disabled: isProfileLocked || !supportsTableMutations,
            onClick: () => actions.importTableData(tableMenu.table),
          },
          { type: "sep" },
          {
            type: "item",
            label: "Clone...",
            disabled: isProfileLocked || !supportsTableMutations,
            onClick: () => actions.cloneTable(tableMenu.table),
          },
          {
            type: "item",
            label: "Truncate...",
            disabled: isProfileLocked || !supportsTableMutations,
            onClick: () => actions.truncateTable(tableMenu.table),
          },
          {
            type: "item",
            label: "Drop...",
            disabled: isProfileLocked || !supportsTableMutations,
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
          <Input
            type="text"
            placeholder="Search tables…"
            left={<SearchIcon className="size-3.5 text-neutral-500" />}
            value={tableSearchQuery}
            onInput={(e: any) => setTableSearchQuery(e.currentTarget.value)}
            className={cn("rounded-lg border border-neutral-200 bg-white!")}
          />
        </div>
      </div>

      {/* Middle: Sections */}
      <div class="flex-1 overflow-y-auto px-2 pb-2">
        {/* Functions (hidden for Mongo; schema = database, no SQL functions) */}
        {!isMongo && !isRedis && (
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
              <div class="mt-1">
                {filteredFunctions.length === 0 ? (
                  <div class="rounded-xl border border-dashed border-neutral-200 bg-white/80 px-3 py-4 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
                    <div class="mx-auto mb-2 flex size-8 items-center justify-center rounded-full bg-neutral-100">
                      <SquareFunctionIcon className="size-4 text-blue-500" />
                    </div>
                    <div class="text-sm font-medium text-neutral-700">
                      No functions found
                    </div>
                  </div>
                ) : (
                  <div class="space-y-1 pl-3">
                    {filteredFunctions.map((fn) => {
                      const key = `${fn.schema}.${fn.name}(${fn.args ?? ""})`;

                      return (
                        <div
                          key={key}
                          class={cn(
                            "flex items-center gap-2 rounded-md px-2.5 py-1.5",
                            "text-left text-sm text-neutral-700"
                          )}
                          title={key}
                        >
                          <SquareFunctionIcon className="size-4 shrink-0 text-blue-500" />
                          <TableName name={fn.name} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tables / Collections */}
        <div>
          <SectionHeader
            title={tablesSectionTitle}
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
                <EmptyItemsState
                  isMongo={isMongo}
                  isRedis={isRedis}
                  hasSearch={tableSearchQuery.trim().length > 0}
                />
              ) : (
                <div class="space-y-1 pl-3">
                  {filteredTables.map((table) => {
                    const key = `${table.schema}.${table.name}`;
                    const isActive = activeWindowId === `table:${key}`;
                    const hasChanges = windowHasPatchChanges(
                      dataPatchMap[profileId]?.[`table:${key}`]
                    );
                    const isNewTable = !!table.new;

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
                          !isActive &&
                            "hover:border-neutral-200/60! hover:bg-neutral-200/60 active:bg-neutral-200/60",
                          isNewTable &&
                            !isActive &&
                            "bg-green-200 text-emerald-900 hover:border-green-200! hover:bg-green-200/80 active:border-green-200! active:bg-green-200/90",
                          hasChanges &&
                            !isActive &&
                            "border-amber-200 bg-amber-200 text-neutral-600 hover:border-amber-200! hover:bg-amber-200/60 active:bg-amber-200/80"
                        )}
                        title={key}
                      >
                        {isRedis ? (
                          <KeyIcon
                            className={cn(
                              "size-4 shrink-0",
                              isActive ? "text-neutral-100" : "text-amber-500"
                            )}
                          />
                        ) : (
                          <TableIcon
                            className={cn(
                              "size-4 shrink-0",
                              isActive ? "text-neutral-100" : "text-blue-500"
                            )}
                          />
                        )}
                        <TableName
                          className={cn(
                            isNewTable && "bg-green-200 text-emerald-900",
                            hasChanges && "bg-amber-200 text-neutral-600"
                          )}
                          name={table.name}
                        />
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

      {deleteRedisKeyTarget && (
        <DeleteRedisKeyDialog
          open={true}
          keyName={deleteRedisKeyTarget.name}
          onClose={() => setDeleteRedisKeyTarget(null)}
          onConfirm={() => actions.deleteRedisKey(deleteRedisKeyTarget)}
        />
      )}

      {renameRedisKeyTarget && (
        <RenameRedisKeyDialog
          open={true}
          keyName={renameRedisKeyTarget.name}
          onClose={() => setRenameRedisKeyTarget(null)}
          onConfirm={(nextName) =>
            actions.renameRedisKey(renameRedisKeyTarget, nextName)
          }
        />
      )}

      <div class="m-2 rounded-lg border border-slate-200 bg-white/60 px-2 py-1 text-xs text-slate-600">
        Tips:
        <ul class="list-decimal pl-4.5">
          <li>Right-click a table for actions.</li>
          <li>Shift+Click to select multiple rows.</li>
        </ul>
      </div>

      {/* Bottom: Toolbar — Database (Mongo) / Schema (SQL) selector */}
      <div class="border-t border-neutral-200 bg-neutral-100 p-2">
        <div class="flex items-center gap-2">
          <NewTableMenu
            disabled={isProfileLocked || !supportsTableMutations}
            enableNewSchema={engine === "postgres"}
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
            aria-label={schemaLabel}
            title={schemaLabel}
            className={cn(
              "h-6 w-full rounded-lg border-neutral-300 bg-white",
              "text-xs! font-medium! text-neutral-800",
              "focus:border-neutral-300 focus:ring-2 focus:ring-black/5"
            )}
            value={currSchema}
            onChange={(e) => onSchemaChange(e.currentTarget.value)}
          >
            {(isMongo ? [schemas[0]] : schemas).map((schema) => (
              <option value={schema}>{schema}</option>
            ))}
          </Select>
        </div>
      </div>
    </aside>
  );
}
