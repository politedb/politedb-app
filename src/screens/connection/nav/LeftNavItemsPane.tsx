import { SetStateAction } from "preact/compat";
import { Dispatch, useState } from "preact/hooks";
import {
  KeyIcon,
  EyeIcon,
  RefreshCwIcon,
  TableIcon,
} from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import { NewTableMenu } from "src/components/table/NewTableMenu";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import { DeleteRedisKeyDialog } from "src/components/modal/DeleteRedisKeyDialog";
import { RenameRedisKeyDialog } from "src/components/modal/RenameRedisKeyDialog";
import { CloneTableDialog } from "src/components/modal/CloneTableDialog";
import { confirmDropTable } from "../hooks/useTableDestructiveActions";
import { cn } from "src/utils/cn";
import type { DatabaseEngine, TableItem } from "src/types";
import { supportsNewSchema } from "src/lib/engines";
import { standaloneExportUnavailableReason } from "../export/standalone-export/support";
import { useMiddleEllipsisByWidth } from "src/hooks/useMiddleEllipsisByWidth";
import { useConnectionActionsCtx } from "../workspace/ConnectionActionsContext";
import { useConnectionRuntimeCtx } from "../workspace/ConnectionRuntimeContext";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import { useConnectionWindows } from "../hooks/useConnectionWindows";
import { useInfiniteScroll } from "src/hooks/useInfiniteScroll";
import {
  tableSidebarButtonClass,
  tableSidebarIconClass,
  tableSidebarNameClass,
} from "../lib/tableSidebarNameClass";
import { EmptyExpandSection } from "./EmptyExpandSection";
import { SidebarSearch } from "./SidebarSearch";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { handleSidebarListKeyDown } from "./sidebarListKeys";
import { quoteTableName } from "src/lib/sql/sqlDialect";
import { tableSelectSnippet } from "src/lib/queries/sql";

const VIEW_LIST_PAGE_SIZE = 20;
// Tables render a page at a time: a schema can hold thousands.
const TABLE_LIST_PAGE_SIZE = 100;

function tableWindowId(
  table: Pick<TableItem, "schema" | "name" | "draftWindowId">
) {
  // A closed draft keeps its own window id, whatever its name now.
  return table.draftWindowId ?? `table:${table.schema}.${table.name}`;
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
    <div class="rounded-xl border border-dashed border-neutral-200 bg-white/80 px-3 py-4 text-center">
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
  const exportUnavailableReason = standaloneExportUnavailableReason(engine);
  const {
    visibleItems: visibleViews,
    sentinelRef: viewListSentinelRef,
    hasMore: hasMoreViews,
  } = useInfiniteScroll(filteredViews, {
    pageSize: VIEW_LIST_PAGE_SIZE,
    resetKey: `${currSchema}\0${tableSearchQuery}`,
  });

  const activeTableIndex = filteredTables.findIndex(
    (table) => activeWindowId === tableWindowId(table)
  );
  const {
    visibleItems: visibleTables,
    sentinelRef: tableListSentinelRef,
    hasMore: hasMoreTables,
  } = useInfiniteScroll(filteredTables, {
    pageSize: TABLE_LIST_PAGE_SIZE,
    resetKey: `${currSchema}\0${tableSearchQuery}`,
    keepVisibleIndex: activeTableIndex,
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
  const [refreshing, setRefreshing] = useState(false);
  const refreshList = async () => {
    setRefreshing(true);
    try {
      await rt.refreshSchemaAndTables();
    } finally {
      setRefreshing(false);
    }
  };
  const getNewTableDraft = (table: TableItem) => {
    return useConnectionStore.getState().newTableData[profileId]?.[
      tableWindowId(table)
    ];
  };

  /** An unsaved table only exists as a draft: confirm natively, then discard it. */
  const dropNewTable = async (table: TableItem) => {
    const name = getNewTableDraft(table)?.tableName || table.name;
    if (!(await confirmDropTable(name))) return;
    const windowId = tableWindowId(table);
    useConnectionStore.getState().clearNewTableData(profileId, windowId);
    await actions.closeWindow(windowId, new MouseEvent("click"));
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
            label: "Open data",
            onClick: () => {
              void actions.selectTable(tableMenu.table);
            },
          },
          {
            type: "item",
            label: "Open structure",
            onClick: () => actions.openTableStructure(tableMenu.table),
          },
          {
            type: "item",
            label:
              tableMenu.table.kind === "view"
                ? "Show in views list"
                : "Show in tables list",
            onClick: () => {
              const catalogKind =
                tableMenu.table.kind === "view" ? "views" : "tables";
              openDatabaseCatalog(
                catalogKind,
                tableMenu.table.schema || currSchema
              );
            },
          },
          { type: "sep" },
          {
            type: "item",
            label: "Copy name",
            onClick: () => navigator.clipboard.writeText(tableMenu.table.name),
          },
          // SQL text: not for Mongo collections.
          ...(isMongo
            ? []
            : ([
                {
                  type: "item",
                  label: "Copy qualified name",
                  onClick: () =>
                    navigator.clipboard.writeText(
                      quoteTableName(
                        tableMenu.table.schema,
                        tableMenu.table.name,
                        engine
                      )
                    ),
                },
                {
                  type: "item",
                  label: "Copy SELECT",
                  disabled: !!tableMenu.table.new,
                  onClick: () =>
                    navigator.clipboard.writeText(
                      tableSelectSnippet(
                        tableMenu.table.schema,
                        tableMenu.table.name,
                        engine
                      )
                    ),
                },
              ] satisfies MenuItem[])),
          { type: "sep" },
          {
            type: "item",
            label: exportUnavailableReason
              ? `Export data... (${exportUnavailableReason})`
              : "Export data...",
            disabled: !!tableMenu.table.new || !!exportUnavailableReason,
            onClick: () => actions.exportTableData(tableMenu.table),
          },
          {
            type: "item",
            label: "Import",
            disabled:
              !!tableMenu.table.new ||
              isProfileLocked ||
              !supportsTableMutations,
            submenu: [
              {
                type: "item",
                label: "From CSV...",
                onClick: () => actions.importTableData(tableMenu.table),
              },
              {
                type: "item",
                label: "From SQL Dump...",
                onClick: () => actions.importTableSqlDump(tableMenu.table),
              },
            ],
          },
          { type: "sep" },
          {
            type: "item",
            label: "Clone...",
            disabled:
              isProfileLocked ||
              !supportsTableMutations ||
              !!tableMenu.table.unresolvedDraft,
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
            color: "red",
            label: "Truncate...",
            disabled:
              !!tableMenu.table.new ||
              isProfileLocked ||
              !supportsTableMutations,
            onClick: () => actions.truncateTable(tableMenu.table),
          },
          {
            type: "item",
            color: "red",
            label: "Drop...",
            disabled: isProfileLocked || !supportsTableMutations,
            onClick: () => {
              if (tableMenu.table.new) {
                void dropNewTable(tableMenu.table);
                return;
              }
              actions.dropTable(tableMenu.table);
            },
          },
        ]
    : [];

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SidebarSearch
        value={tableSearchQuery}
        onChange={setTableSearchQuery}
        placeholder={
          isRedis
            ? "Search keys…"
            : isMongo
              ? "Search collections…"
              : "Search tables, views…"
        }
        label={
          isRedis
            ? "Search keys"
            : isMongo
              ? "Search collections"
              : "Search tables and views"
        }
      />

      {/* Middle: Sections */}
      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        data-scroll-root
        onKeyDown={handleSidebarListKeyDown}
      >
        {/* Table Views (hidden for Mongo/Redis) */}
        {!isMongo && !isRedis && (
          <div class="mb-2">
            <SidebarSectionHeader
              title="Views"
              count={filteredViews.length}
              expanded={expandedSections.views}
              onOpenList={() => openDatabaseCatalog("views", currSchema)}
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
                          data-sidebar-item
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
          <SidebarSectionHeader
            title={tablesSectionTitle}
            count={filteredTables.length}
            expanded={expandedSections.tables}
            onOpenList={
              isRedis || isMongo
                ? undefined
                : () => openDatabaseCatalog("tables", currSchema)
            }
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
                  {visibleTables.map((table) => {
                    const key = `${table.schema}.${table.name}`;
                    // A closed draft is its own item, whatever its name.
                    const itemKey = table.draftWindowId ?? key;
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
                        data-sidebar-item
                        variant={useDefaultActive ? "default" : "ghost"}
                        active={useDefaultActive}
                        key={itemKey}
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
                  {hasMoreTables ? (
                    <div
                      ref={tableListSentinelRef}
                      class="h-px"
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ContextMenu
        autoFocus
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
                schema: nextTable.schema,
                windowName: nextTable.name,
                tableName: newTableName,
                primaryKey: sourceDraft?.primaryKey ?? "",
                columns: structuredClone(sourceDraft?.columns ?? []),
              });
          }}
        />
      )}

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
            {/* A Mongo tab is one database (open others from the database
                manager), so it lists only its own. */}
            {(isMongo ? [currSchema || schemas[0]] : schemas).map((schema) => (
              <option value={schema}>{schema}</option>
            ))}
          </Select>

          <Button
            variant="outline"
            className="size-7 shrink-0 border-neutral-300 bg-white p-1"
            title={`Refresh ${tablesSectionTitle.toLowerCase()}`}
            aria-label={`Refresh ${tablesSectionTitle.toLowerCase()}`}
            disabled={connectionChromeBlocked || refreshing}
            onClick={() => void refreshList()}
          >
            <RefreshCwIcon
              className={cn(
                "size-3.5 text-neutral-700",
                refreshing && "animate-spin"
              )}
            />
          </Button>
        </div>
      </div>
    </div>
  );
}
