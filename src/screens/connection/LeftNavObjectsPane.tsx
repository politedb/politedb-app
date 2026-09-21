import { useEffect, useMemo, useState } from "preact/hooks";
import { useScreenStore } from "src/stores/screen";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  SearchIcon,
  SquareFunctionIcon,
} from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { Select } from "src/components/common/Select";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { cn } from "src/utils/cn";
import type { DatabaseObjectItem, DatabaseObjectKind } from "src/types";
import {
  buildDropDatabaseObjectSql,
  objectKindLabel,
  objectKindSingular,
} from "src/lib/databaseObjects";
import { runSqlQuery } from "src/lib/tauri/query";
import { showToast } from "src/stores/toast";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import {
  tableSidebarButtonClass,
  tableSidebarIconClass,
  tableSidebarNameClass,
} from "./tableSidebarNameClass";
import { EmptyExpandSection } from "./EmptyExpandSection";

const OBJECT_KINDS: DatabaseObjectKind[] = ["function", "procedure", "trigger"];
const EMPTY_WINDOWS: import("src/types").OpenWindow[] = [];

type Props = {
  profileId: string;
};

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

export function LeftNavObjectsPane({ profileId }: Props) {
  const rt = useConnectionRuntimeCtx();
  const { openDatabaseObjectsManager, openDatabaseCatalog, selectWindow } =
    useConnectionWindows(profileId);
  const openWindows = useScreenStore(
    (s) => s.openWindows[profileId] ?? EMPTY_WINDOWS
  );
  const activeWindowId = useScreenStore(
    (s) => s.activeWindowId[profileId] ?? null
  );

  const createDrafts = useMemo(() => {
    return openWindows.filter(
      (w): w is Extract<typeof w, { type: "db-object-manager" }> =>
        w.type === "db-object-manager" && !(w.initialObjectId ?? "").trim()
    );
  }, [openWindows]);

  const activeObjectWindow = useMemo(() => {
    const w = openWindows.find((win) => win.id === activeWindowId);
    return w?.type === "db-object-manager" ? w : null;
  }, [openWindows, activeWindowId]);

  const [query, setQuery] = useState("");
  const [schemaFilter, setSchemaFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<DatabaseObjectKind, boolean>>(
    {
      function: true,
      procedure: false,
      trigger: false,
    }
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    item: DatabaseObjectItem;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<DatabaseObjectItem | null>(null);
  const [dropping, setDropping] = useState(false);

  const meta = useMemo(
    () =>
      rt.metadata.get({
        metaKey: rt.metaKey,
        engine: rt.engine,
        connectionId: rt.runtimeConnectionId,
        lazy: true,
      }),
    [rt]
  );

  const availableSchemas = useMemo(() => meta.schemas ?? [], [meta.schemas]);

  useEffect(() => {
    if (!availableSchemas.length) {
      setSchemaFilter(rt.activeSchema || "");
      return;
    }
    if (schemaFilter && availableSchemas.includes(schemaFilter)) return;
    setSchemaFilter(rt.activeSchema || availableSchemas[0] || "");
  }, [availableSchemas, schemaFilter, rt.activeSchema]);

  const objectsByKind = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = meta.objects ?? [];
    const filtered = all
      .filter((item) => {
        if (schemaFilter && item.schema !== schemaFilter) return false;
        if (!q) return true;
        return (
          item.name.toLowerCase().includes(q) ||
          item.schema.toLowerCase().includes(q) ||
          `${item.schema}.${item.name}`.toLowerCase().includes(q)
        );
      })
      .slice()
      .sort((a, b) => {
        if (a.schema !== b.schema) return a.schema.localeCompare(b.schema);
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

    const grouped: Record<DatabaseObjectKind, DatabaseObjectItem[]> = {
      function: [],
      procedure: [],
      trigger: [],
    };
    for (const item of filtered) {
      grouped[item.kind].push(item);
    }
    return grouped;
  }, [meta.objects, query, schemaFilter]);

  const totalCount =
    objectsByKind.function.length +
    objectsByKind.procedure.length +
    objectsByKind.trigger.length;

  const createDraftKindsKey = createDrafts
    .map((d) => `${d.id}:${d.initialKind ?? "function"}`)
    .join("|");

  // When creating, land drafts in their matching sections (like new tables).
  useEffect(() => {
    if (!createDraftKindsKey) return;
    const kinds = createDraftKindsKey
      .split("|")
      .map((part) => part.split(":")[1] as DatabaseObjectKind);
    setExpanded((prev) => {
      let next = prev;
      for (const kind of kinds) {
        if (kind && !next[kind]) {
          next = { ...next, [kind]: true };
        }
      }
      return next;
    });
  }, [createDraftKindsKey]);

  const toggleKind = (kind: DatabaseObjectKind) => {
    setExpanded((prev) => ({ ...prev, [kind]: !prev[kind] }));
  };

  const openCatalogForKind = (kind: DatabaseObjectKind) => {
    const catalogKind =
      kind === "function"
        ? ("functions" as const)
        : kind === "procedure"
          ? ("procedures" as const)
          : ("triggers" as const);
    openDatabaseCatalog(
      catalogKind,
      schemaFilter || rt.activeSchema || undefined
    );
  };

  const openCreate = () => {
    openDatabaseObjectsManager({ kind: "function" });
  };

  const openObject = (item: DatabaseObjectItem) => {
    openDatabaseObjectsManager({ kind: item.kind, object: item });
  };

  const openCatalogForItem = (item: DatabaseObjectItem) => {
    const catalogKind =
      item.kind === "function"
        ? ("functions" as const)
        : item.kind === "procedure"
          ? ("procedures" as const)
          : ("triggers" as const);
    openDatabaseCatalog(catalogKind, item.schema);
  };

  const menuItems: MenuItem[] = menu
    ? [
        {
          type: "item",
          label: "Open",
          onClick: () => openObject(menu.item),
        },
        {
          type: "item",
          label: "Copy name",
          onClick: () => void navigator.clipboard.writeText(menu.item.name),
        },
        {
          type: "item",
          label: "Open in catalog",
          onClick: () => openCatalogForItem(menu.item),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Drop…",
          color: "red",
          disabled: !menu.item.capability.canDelete || !rt.runtimeConnectionId,
          onClick: () => setDropTarget(menu.item),
        },
      ]
    : [];

  const confirmDrop = async () => {
    if (!dropTarget || !rt.runtimeConnectionId) return;
    setDropping(true);
    try {
      const sql = buildDropDatabaseObjectSql({
        engine: rt.engine,
        item: dropTarget,
      });
      await runSqlQuery(rt.runtimeConnectionId, sql);
      await rt.refreshSchemaAndTables();
      showToast(
        `Dropped ${objectKindSingular(dropTarget.kind)} “${dropTarget.name}”.`,
        {
          tone: "success",
        }
      );
      setDropTarget(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err ?? ""), {
        tone: "error",
      });
    } finally {
      setDropping(false);
    }
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div data-density-sidebar-header class="p-2">
        <div class="relative">
          <Input
            type="text"
            placeholder="Search objects…"
            left={<SearchIcon className="size-4 text-neutral-500" />}
            value={query}
            onValueChange={setQuery}
            className={cn(
              "rounded-lg border border-neutral-200 bg-white py-1.5 text-sm"
            )}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-scroll-root>
        {!rt.runtimeConnectionId ? (
          <div class="rounded-xl border border-dashed border-neutral-200 bg-white/80 px-3 py-4 text-center shadow-sm">
            <div class="text-sm font-medium text-neutral-700">
              Connect to a profile to browse objects.
            </div>
          </div>
        ) : totalCount === 0 && query.trim() ? (
          <div class="rounded-xl border border-dashed border-neutral-200 bg-white/80 px-3 py-4 text-center shadow-sm">
            <div class="text-sm font-medium text-neutral-700">
              No matching objects
            </div>
          </div>
        ) : (
          <div class="space-y-2">
            {OBJECT_KINDS.map((kind) => {
              const items = objectsByKind[kind];
              const isExpanded = expanded[kind];
              return (
                <div key={kind}>
                  <SectionHeader
                    title={objectKindLabel(kind)}
                    expanded={isExpanded}
                    onToggle={() => toggleKind(kind)}
                    onOpen={() => openCatalogForKind(kind)}
                  />
                  {isExpanded ? (
                    <div class="mt-1">
                      {(() => {
                        const draftsForKind = createDrafts.filter((draft) => {
                          const draftKind = draft.initialKind ?? "function";
                          if (draftKind !== kind) return false;
                          const draftName =
                            draft.title?.trim() ||
                            (draftKind === "trigger"
                              ? "new_trigger"
                              : `new_${draftKind}`);
                          const q = query.trim().toLowerCase();
                          if (!q) return true;
                          return draftName.toLowerCase().includes(q);
                        });
                        if (items.length === 0 && draftsForKind.length === 0) {
                          return (
                            <EmptyExpandSection
                              Icon={SquareFunctionIcon}
                              description={`No ${objectKindLabel(kind).toLowerCase()} found`}
                            />
                          );
                        }
                        return (
                          <div class="space-y-1 pl-3">
                            {draftsForKind.map((draft) => {
                              const draftKind = draft.initialKind ?? "function";
                              const draftName =
                                draft.title?.trim() ||
                                (draftKind === "trigger"
                                  ? "new_trigger"
                                  : `new_${draftKind}`);
                              const isActive = activeWindowId === draft.id;
                              return (
                                <Button
                                  key={draft.id}
                                  data-density-item
                                  variant="ghost"
                                  title={draftName}
                                  onClick={() => selectWindow(draft.id)}
                                  className={cn(
                                    tableSidebarButtonClass({
                                      isActive,
                                      isNewTable: true,
                                      hasChanges: false,
                                    }),
                                    isActive && "font-medium"
                                  )}
                                >
                                  <SquareFunctionIcon
                                    className={cn(
                                      "size-4 shrink-0",
                                      tableSidebarIconClass({
                                        isActive,
                                        isRedis: false,
                                      })
                                    )}
                                  />
                                  <span
                                    class={cn(
                                      "min-w-0 flex-1 truncate text-left select-none",
                                      tableSidebarNameClass({
                                        isActive,
                                        isNewTable: true,
                                        hasChanges: false,
                                      })
                                    )}
                                  >
                                    {draftName}
                                  </span>
                                </Button>
                              );
                            })}
                            {items.map((item) => {
                              const isActive =
                                !!activeObjectWindow &&
                                !!(
                                  activeObjectWindow.initialObjectId ?? ""
                                ).trim() &&
                                activeObjectWindow.initialObjectId === item.id;
                              const hasChanges =
                                isActive && !!activeObjectWindow?.dirty;
                              const useDefaultActive = isActive && !hasChanges;
                              return (
                                <Button
                                  key={item.id}
                                  data-density-item
                                  variant={
                                    useDefaultActive ? "default" : "ghost"
                                  }
                                  active={useDefaultActive}
                                  title={`${item.schema}.${item.name}`}
                                  onClick={() => openObject(item)}
                                  onContextMenu={(e: MouseEvent) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setMenu({
                                      x: e.clientX,
                                      y: e.clientY,
                                      item,
                                    });
                                  }}
                                  className={cn(
                                    tableSidebarButtonClass({
                                      isActive,
                                      isNewTable: false,
                                      hasChanges,
                                    }),
                                    useDefaultActive && "font-medium"
                                  )}
                                >
                                  <SquareFunctionIcon
                                    className={cn(
                                      "size-4 shrink-0",
                                      tableSidebarIconClass({
                                        isActive,
                                        isRedis: false,
                                      })
                                    )}
                                  />
                                  <span
                                    class={cn(
                                      "min-w-0 flex-1 truncate text-left select-none",
                                      tableSidebarNameClass({
                                        isActive,
                                        isNewTable: false,
                                        hasChanges,
                                      })
                                    )}
                                  >
                                    {item.name}
                                  </span>
                                </Button>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div class="border-t border-neutral-200 bg-neutral-100 p-2">
        <div class="flex items-center gap-1">
          <Button
            variant="outline"
            className={cn(
              "size-7 shrink-0 p-1 text-sm",
              "border-neutral-300 bg-white"
            )}
            title="New object"
            disabled={!rt.runtimeConnectionId}
            onClick={openCreate}
          >
            <PlusIcon class="size-2.5 text-neutral-800" />
          </Button>

          <Select
            aria-label="Schema"
            title="Schema"
            disabled={!rt.runtimeConnectionId || availableSchemas.length === 0}
            className={cn(
              "h-7 w-full border-neutral-300 text-neutral-800",
              "focus:border-neutral-300 focus:ring-2 focus:ring-black/5"
            )}
            value={schemaFilter}
            onChange={(e) =>
              setSchemaFilter((e.currentTarget as HTMLSelectElement).value)
            }
          >
            {availableSchemas.map((schema) => (
              <option key={schema} value={schema}>
                {schema}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ContextMenu
        open={!!menu}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />

      <Dialog
        open={!!dropTarget}
        onClose={() => (dropping ? null : setDropTarget(null))}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>
            Drop {dropTarget ? objectKindSingular(dropTarget.kind) : "object"}
          </DialogTitle>
        </DialogHeader>
        <DialogContent>
          <p class="text-sm text-neutral-600">
            Drop{" "}
            {dropTarget
              ? `${dropTarget.schema}.${dropTarget.name}`
              : "this object"}
            ? This cannot be undone.
          </p>
        </DialogContent>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={dropping}
            onClick={() => setDropTarget(null)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={dropping}
            onClick={() => void confirmDrop()}
          >
            Drop
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
