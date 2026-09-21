import { SetStateAction } from "preact/compat";
import { Dispatch, useState } from "preact/hooks";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  KeyIcon,
  EyeIcon,
  SearchIcon,
  TableIcon,
  LightBulbIcon,
} from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import { NewTableMenu } from "src/components/table/NewTableMenu";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import { DeleteRedisKeyDialog } from "src/components/modal/DeleteRedisKeyDialog";
import { RenameRedisKeyDialog } from "src/components/modal/RenameRedisKeyDialog";
import { CloneTableDialog } from "src/components/modal/CloneTableDialog";
import { DropTableDialog } from "src/components/modal/DropTableDialog";
import { cn } from "src/utils/cn";
import type { DatabaseEngine, TableItem } from "src/types";
import { supportsNewSchema } from "src/lib/engines";
import { useMiddleEllipsisByWidth } from "src/hooks/useMiddleEllipsisByWidth";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { Input } from "src/components/common/Input";
import { useInfiniteScroll } from "src/hooks/useInfiniteScroll";
import {
  tableSidebarButtonClass,
  tableSidebarIconClass,
  tableSidebarNameClass,
} from "./tableSidebarNameClass";
import { EmptyExpandSection } from "./EmptyExpandSection";

const VIEW_LIST_PAGE_SIZE = 20;

function tableWindowId(table: Pick<TableItem, "schema" | "name">) {
  return `table:${table.schema}.${table.name}`;
}

function SectionHeader(props: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const { title, expanded, onToggle, onOpen } = props;

  return (
    <Button
      data-density-item
      variant="ghost"
      class="w-full justify-start rounded-md border-none px-2 py-1.5 hover:bg-neutral-200/60 active:bg-neutral-200/80"
      onClick={onOpen ?? onToggle}
    >
      <div
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
        className="shrink-0"
        title={expanded ? `Collapse ${title}` : `Expand ${title}`}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3.5 text-neutral-500" />
        ) : (
          <ChevronRightIcon className="size-3.5 text-neutral-500" />
        )}
      </div>
      <span class="min-w-0 truncate text-start text-sm font-semibold tracking-wide text-neutral-600">
        {title}
      </span>
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

export type LeftNavItemsPaneProps = {
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
  expandedSections: { views: boolean; tables: boolean };
  setExpandedSections: Dispatch<
    SetStateAction<{ views: boolean; tables: boolean }>
  >;
  filteredTables: TableItem[];
  filteredViews: TableItem[];
  activeWindowId: string | null;
};

export function LeftNavItemsPane({
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
  filteredViews,
  activeWindowId,
}: LeftNavItemsPaneProps) {
  const actions = useConnectionActionsCtx();
  const rt = useConnectionRuntimeCtx();
  const connectionChromeBlocked = !rt.runtimeConnectionId;
  const dataPatchMap = useConnectionStore((state) => state.dataPatchMap);
  const isProfileLocked = useScreenStore(
    (s) => s.profileTabs.find((t) => t.id === profileId)?.isLocked ?? false
  );
  const { windowHasPatchChanges, openDatabaseCatalog } =
    useConnectionWindows(profileId);
  const isMongo = engine === "mongo";
  const isRedis = engine === "redis";
  const supportsTableMutations = !isMongo && !isRedis;
  const {
    visibleItems: visibleViews,
    sentinelRef: viewListSentinelRef,
    hasMore: hasMoreViews,
  } = useInfiniteScroll(filteredViews, {
    pageSize: VIEW_LIST_PAGE_SIZE,
    resetKey: `${currSchema}\0${tableSearchQuery}`,
  });

  const [tableMenu, setTableMenu] = useState<{
    x: number;
    y: number;
    table: TableItem;
  } | null>(null);
  const [deleteRedisKeyTarget, setDeleteRedisKeyTarget] =
    useState<TableItem | null>(null);
  const [renameRedisKeyTarget, setRenameRedisKeyTarget] =
    useState<TableItem | null>(null);
  const [cloneNewTableTarget, setCloneNewTableTarget] =
    useState<TableItem | null>(null);
  const [dropNewTableTarget, setDropNewTableTarget] =
    useState<TableItem | null>(null);

  const getNewTableDraft = (table: TableItem) => {
    return useConnectionStore.getState().newTableData[profileId]?.[
      tableWindowId(table)
    ];
  };

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
            label: "Open",
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
            label: "Export data...",
            disabled: !!tableMenu.table.new,
            onClick: () => actions.exportTableData(tableMenu.table),
          },
          {
            type: "item",
            label: "Import data from CSV",
            disabled:
              !!tableMenu.table.new ||
              isProfileLocked ||
              !supportsTableMutations,
            onClick: () => actions.importTableData(tableMenu.table),
          },
          { type: "sep" },
          {
            type: "item",
            label: "Clone...",
            disabled: isProfileLocked || !supportsTableMutations,
            onClick: () => {
              if (tableMenu.table.new) {
                setCloneNewTableTarget(tableMenu.table);
                return;
              }
              actions.cloneTable(tableMenu.table);
            },
          },
          {
            type: "item",
            label: "Truncate...",
            disabled:
              !!tableMenu.table.new ||
              isProfileLocked ||
              !supportsTableMutations,
            onClick: () => actions.truncateTable(tableMenu.table),
          },
          {
            type: "item",
            label: "Drop...",
            disabled: isProfileLocked || !supportsTableMutations,
            onClick: () => {
              if (tableMenu.table.new) {
                setDropNewTableTarget(tableMenu.table);
                return;
              }
              actions.dropTable(tableMenu.table);
            },
          },
        ]
    : [];

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Top: Search */}
      <div data-density-sidebar-header class="p-2">
        <div class="relative">
          <Input
            type="text"
            placeholder="Search tables, views…"
            left={<SearchIcon className="size-4 text-neutral-500" />}
            value={tableSearchQuery}
            onInput={(e: any) => setTableSearchQuery(e.currentTarget.value)}
            className={cn(
              "rounded-lg border border-neutral-200 bg-white py-1.5 text-sm"
            )}
          />
        </div>
      </div>

      {/* Middle: Sections */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-scroll-root>
        {/* Table Views (hidden for Mongo/Redis) */}
        {!isMongo && !isRedis && (
          <div class="mb-2">
            <SectionHeader
              title="Views"
              expanded={expandedSections.views}
              onOpen={() => openDatabaseCatalog("views", currSchema)}
              onToggle={() =>
                setExpandedSections((prev) => ({
                  ...prev,
                  views: !prev.views,
                }))
              }
            />

            {expandedSections.views && (
              <div class="mt-1">
                {filteredViews.length === 0 ? (
                  <EmptyExpandSection
                    Icon={EyeIcon}
                    description="No views found"
                  />
                ) : (
                  <div class="space-y-1 pl-3">
                    {visibleViews.map((view) => {
                      const key = `${view.schema}.${view.name}`;
                      const isActive = activeWindowId === `table:${key}`;
                      const hasChanges = windowHasPatchChanges(
                        dataPatchMap[profileId]?.[`table:${key}`]
                      );

                      return (
                        <Button
                          data-density-item
                          variant={
                            isActive && !hasChanges ? "default" : "ghost"
                          }
                          active={isActive && !hasChanges}
                          key={key}
                          onClick={() => void actions.selectTable(view)}
                          onContextMenu={(e: MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setTableMenu({
                              x: e.clientX,
                              y: e.clientY,
                              table: view,
                            });
                          }}
                          className={cn(
                            tableSidebarButtonClass({
                              isActive,
                              isNewTable: false,
                              hasChanges,
                            }),
                            isActive && !hasChanges && "font-medium"
                          )}
                          title={key}
                        >
                          <EyeIcon
                            className={cn(
                              "size-4 shrink-0",
                              tableSidebarIconClass({
                                isActive,
                                isRedis: false,
                              })
                            )}
                          />
                          <TableName
                            className={tableSidebarNameClass({
                              isActive,
                              isNewTable: false,
                              hasChanges,
                            })}
                            name={view.name}
                          />
                        </Button>
                      );
                    })}
                    {hasMoreViews ? (
                      <div
                        ref={viewListSentinelRef}
                        class="h-px"
                        aria-hidden="true"
                      />
                    ) : null}
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
            onOpen={() => {
              if (!isRedis && !isMongo)
                openDatabaseCatalog("tables", currSchema);
            }}
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
                    const useDefaultActive =
                      isActive && !isNewTable && !hasChanges;

                    return (
                      <Button
                        data-density-item
                        variant={useDefaultActive ? "default" : "ghost"}
                        active={useDefaultActive}
                        key={key}
                        onClick={() => void actions.selectTable(table)}
                        onContextMenu={(e: MouseEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setTableMenu({
                            x: e.clientX,
                            y: e.clientY,
                            table,
                          });
                        }}
                        className={cn(
                          tableSidebarButtonClass({
                            isActive,
                            isNewTable,
                            hasChanges,
                          }),
                          useDefaultActive && "font-medium"
                        )}
                        title={key}
                      >
                        {isRedis ? (
                          <KeyIcon
                            className={cn(
                              "size-4 shrink-0",
                              tableSidebarIconClass({
                                isActive,
                                isRedis: true,
                              })
                            )}
                          />
                        ) : (
                          <TableIcon
                            className={cn(
                              "size-4 shrink-0",
                              tableSidebarIconClass({
                                isActive,
                                isRedis: false,
                              })
                            )}
                          />
                        )}
                        <TableName
                          className={tableSidebarNameClass({
                            isActive,
                            isNewTable,
                            hasChanges,
                          })}
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

      {cloneNewTableTarget && (
        <CloneTableDialog
          open={true}
          showCopyDataOption={false}
          sourceTableName={
            getNewTableDraft(cloneNewTableTarget)?.tableName ||
            cloneNewTableTarget.name
          }
          onClose={() => setCloneNewTableTarget(null)}
          onConfirm={async (newTableName) => {
            const sourceDraft = getNewTableDraft(cloneNewTableTarget);
            const nextTable: TableItem = {
              schema: cloneNewTableTarget.schema,
              name: newTableName,
              new: true,
            };
            const nextWindowId = tableWindowId(nextTable);

            await actions.selectTable(nextTable);
            useConnectionStore
              .getState()
              .setNewTableData(profileId, nextWindowId, {
                tableName: newTableName,
                primaryKey: sourceDraft?.primaryKey ?? "",
                columns: structuredClone(sourceDraft?.columns ?? []),
              });
          }}
        />
      )}

      {dropNewTableTarget && (
        <DropTableDialog
          open={true}
          tableName={
            getNewTableDraft(dropNewTableTarget)?.tableName ||
            dropNewTableTarget.name
          }
          onClose={() => setDropNewTableTarget(null)}
          onConfirm={async () => {
            const windowId = tableWindowId(dropNewTableTarget);
            useConnectionStore
              .getState()
              .clearNewTableData(profileId, windowId);
            await actions.closeWindow(windowId, new MouseEvent("click"));
          }}
        />
      )}

      <div
        class={cn(
          "m-2 rounded-xl p-2 text-xs text-blue-600",
          "border border-blue-300 bg-blue-100",
          "shadow-md"
        )}
      >
        <div class="flex items-center gap-1">
          <LightBulbIcon className="inline-block size-4" />
          <span>Quick tips:</span>
        </div>
        <ul class="list-disc pl-5">
          <li>Right-click a table for actions.</li>
          <li>Shift+Click to select multiple rows.</li>
        </ul>
      </div>

      {/* Bottom: Toolbar — Database (Mongo) / Schema (SQL) selector */}
      <div class="border-t border-neutral-200 bg-neutral-100 p-2">
        <div class="flex items-center gap-1">
          <NewTableMenu
            disabled={
              isProfileLocked ||
              !supportsTableMutations ||
              connectionChromeBlocked
            }
            enableNewSchema={supportsNewSchema(engine)}
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
            disabled={connectionChromeBlocked}
            className={cn(
              "h-7 w-full border-neutral-300 text-neutral-800",
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
    </div>
  );
}
