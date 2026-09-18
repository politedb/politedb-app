import { useEffect, useMemo, useState } from "preact/hooks";
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
import { cn } from "src/utils/cn";
import type { DatabaseObjectItem, DatabaseObjectKind } from "src/types";
import { objectKindLabel } from "src/lib/databaseObjects";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import {
  tableSidebarButtonClass,
  tableSidebarIconClass,
  tableSidebarNameClass,
} from "./tableSidebarNameClass";
import { EmptyExpandSection } from "./EmptyExpandSection";

const OBJECT_KINDS: DatabaseObjectKind[] = ["function", "procedure", "trigger"];

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
  const { openDatabaseObjectsManager, openDatabaseCatalog } =
    useConnectionWindows(profileId);

  const [query, setQuery] = useState("");
  const [schemaFilter, setSchemaFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<DatabaseObjectKind, boolean>>(
    {
      function: true,
      procedure: false,
      trigger: false,
    }
  );

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
                      {items.length === 0 ? (
                        <EmptyExpandSection
                          Icon={SquareFunctionIcon}
                          description={`No ${objectKindLabel(kind).toLowerCase()} found`}
                        />
                      ) : (
                        <div class="space-y-1 pl-3">
                          {items.map((item) => (
                            <Button
                              key={item.id}
                              data-density-item
                              variant="ghost"
                              title={`${item.schema}.${item.name}`}
                              onClick={() =>
                                openDatabaseObjectsManager({
                                  kind: item.kind,
                                  object: item,
                                })
                              }
                              className={cn(
                                tableSidebarButtonClass({
                                  isActive: false,
                                  isNewTable: false,
                                  hasChanges: false,
                                })
                              )}
                            >
                              <SquareFunctionIcon
                                className={cn(
                                  "size-4 shrink-0",
                                  tableSidebarIconClass({
                                    isActive: false,
                                    isRedis: false,
                                  })
                                )}
                              />
                              <span
                                class={cn(
                                  "min-w-0 flex-1 truncate text-left select-none",
                                  tableSidebarNameClass({
                                    isActive: false,
                                    isNewTable: false,
                                    hasChanges: false,
                                  })
                                )}
                              >
                                {item.name}
                              </span>
                            </Button>
                          ))}
                        </div>
                      )}
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
    </div>
  );
}
