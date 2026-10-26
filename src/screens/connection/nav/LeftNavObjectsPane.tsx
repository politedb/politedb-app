import { useEffect, useMemo, useState } from "preact/hooks";
import { useScreenStore } from "src/stores/screen";
import { PlusIcon, SquareFunctionIcon } from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import { cn } from "src/utils/cn";
import type { DatabaseObjectItem, DatabaseObjectKind } from "src/types";
import { objectKindLabel, objectKindSingular } from "src/lib/databaseObjects";
import { useConnectionRuntimeCtx } from "../workspace/ConnectionRuntimeContext";
import { useConnectionWindows } from "../hooks/useConnectionWindows";
import { useDropDatabaseObject } from "../hooks/useDropDatabaseObject";
import { newObjectDraftInit } from "../lib/objectWindows";
import {
  draftKeyForWindow,
  editDraftKey,
  windowIdForDraftKey,
} from "src/lib/objectDraftKey";
import {
  hasPendingWork,
  useObjectDraftStore,
  type ObjectDraft,
} from "src/stores/objectDrafts";
import {
  tableSidebarButtonClass,
  tableSidebarIconClass,
  tableSidebarNameClass,
} from "../lib/tableSidebarNameClass";
import { EmptyExpandSection } from "./EmptyExpandSection";
import { SidebarSearch } from "./SidebarSearch";
import { handleSidebarListKeyDown } from "./sidebarListKeys";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

const OBJECT_KINDS: DatabaseObjectKind[] = ["function", "procedure", "trigger"];
const EMPTY_WINDOWS: import("src/types").OpenWindow[] = [];
const EMPTY_DRAFTS: Record<string, ObjectDraft> = {};

/** A draft's sidebar name: its name, else new_<kind>. */
function draftDisplayName(draft: ObjectDraft) {
  return draft.form.name.trim() || draft.item?.name || `new_${draft.kind}`;
}

type Props = {
  profileId: string;
  /** The schema the sidebar shows, shared with the Items tab. */
  currSchema: string;
  onSchemaChange: (schema: string) => void;
};

export function LeftNavObjectsPane({
  profileId,
  currSchema,
  onSchemaChange,
}: Props) {
  const rt = useConnectionRuntimeCtx();
  const { openDatabaseObjectsManager, openDatabaseCatalog, openObjectDraft } =
    useConnectionWindows(profileId);
  const openWindows = useScreenStore(
    (s) => s.openWindows[profileId] ?? EMPTY_WINDOWS
  );
  const activeWindowId = useScreenStore(
    (s) => s.activeWindowId[profileId] ?? null
  );

  // Every draft of the tab, open or closed (closing a window keeps it).
  const drafts = useObjectDraftStore(
    (s) => s.drafts[profileId] ?? EMPTY_DRAFTS
  );
  // New objects, and edits whose object is gone: both listed by draft.
  const listedDrafts = useMemo(
    () =>
      Object.values(drafts).filter(
        (d) => d.mode === "create" || (d.missing && hasPendingWork(d))
      ),
    [drafts]
  );

  const activeObjectWindow = useMemo(() => {
    const w = openWindows.find((win) => win.id === activeWindowId);
    return w?.type === "db-object-manager" ? w : null;
  }, [openWindows, activeWindowId]);

  const [query, setQuery] = useState("");
  const schemaFilter = currSchema;
  const { canDrop, dropObject } = useDropDatabaseObject(profileId);
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

  const createDraftKindsKey = listedDrafts
    .map((d) => `${d.key}|${d.kind}`)
    .join(",");

  // When creating, land drafts in their matching sections (like new tables).
  useEffect(() => {
    if (!createDraftKindsKey) return;
    const kinds = createDraftKindsKey
      .split(",")
      .map((part) => part.split("|")[1] as DatabaseObjectKind);
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
    openDatabaseObjectsManager({
      createInit: newObjectDraftInit({
        tabId: profileId,
        engine: rt.engine,
        kind: "function",
        schema:
          schemaFilter || rt.activeSchema || availableSchemas[0] || "public",
        tables: meta.tables ?? [],
        existingNames: (meta.objects ?? []).map((item) => item.name),
      }),
    });
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
          label: `Open ${objectKindSingular(menu.item.kind)}`,
          onClick: () => openObject(menu.item),
        },
        {
          type: "item",
          label: `Show in ${objectKindLabel(menu.item.kind).toLowerCase()} list`,
          onClick: () => openCatalogForItem(menu.item),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Copy name",
          onClick: () => void navigator.clipboard.writeText(menu.item.name),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Drop…",
          color: "red",
          disabled: !canDrop(menu.item),
          onClick: () => void dropObject(menu.item),
        },
      ]
    : [];

  // Drafts listed by themselves, shown (and counted) in their kind's
  // section under the same search and schema filter as objects.
  const draftsByKind = useMemo(() => {
    const q = query.trim().toLowerCase();
    const grouped: Record<DatabaseObjectKind, ObjectDraft[]> = {
      function: [],
      procedure: [],
      trigger: [],
    };
    for (const draft of listedDrafts) {
      const schema = draft.form.schema;
      if (schemaFilter && schema && schema !== schemaFilter) continue;
      const name = draftDisplayName(draft).toLowerCase();
      if (
        !q ||
        name.includes(q) ||
        schema.toLowerCase().includes(q) ||
        `${schema}.${name}`.toLowerCase().includes(q)
      ) {
        grouped[draft.kind].push(draft);
      }
    }
    return grouped;
  }, [listedDrafts, query, schemaFilter]);

  const totalDraftCount =
    draftsByKind.function.length +
    draftsByKind.procedure.length +
    draftsByKind.trigger.length;

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SidebarSearch
        value={query}
        onChange={setQuery}
        placeholder="Search objects…"
        label="Search database objects"
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        data-scroll-root
        onKeyDown={handleSidebarListKeyDown}
      >
        {!rt.runtimeConnectionId ? (
          <div class="rounded-xl border border-dashed border-neutral-200 bg-white/80 px-3 py-4 text-center shadow-sm">
            <div class="text-sm font-medium text-neutral-700">
              Connect to a profile to browse objects.
            </div>
          </div>
        ) : totalCount + totalDraftCount === 0 && query.trim() ? (
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
                  <SidebarSectionHeader
                    title={objectKindLabel(kind)}
                    count={items.length + draftsByKind[kind].length}
                    expanded={isExpanded}
                    onToggle={() => toggleKind(kind)}
                    onOpenList={() => openCatalogForKind(kind)}
                  />
                  {isExpanded ? (
                    <div class="mt-1">
                      {(() => {
                        const draftsForKind = draftsByKind[kind];
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
                              const draftName = draftDisplayName(draft);
                              const isActive =
                                activeWindowId ===
                                windowIdForDraftKey(draft.key);
                              return (
                                <Button
                                  key={draft.key}
                                  data-density-item
                                  data-sidebar-item
                                  variant="ghost"
                                  title={
                                    draft.mode === "create"
                                      ? draftName
                                      : `${draftName} (no longer in the database)`
                                  }
                                  onClick={() => openObjectDraft(draft.key)}
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
                                draftKeyForWindow(activeObjectWindow) ===
                                  editDraftKey(item.id);
                              const itemDraft = drafts[editDraftKey(item.id)];
                              const hasChanges =
                                !!itemDraft && hasPendingWork(itemDraft);
                              const useDefaultActive = isActive && !hasChanges;
                              return (
                                <Button
                                  key={item.id}
                                  data-density-item
                                  data-sidebar-item
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
              onSchemaChange((e.currentTarget as HTMLSelectElement).value)
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
        autoFocus
        open={!!menu}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}
