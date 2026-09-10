import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import {
  RefreshCwIcon,
  SearchIcon,
  SquareFunctionIcon,
  TableIcon,
} from "src/components/icons";
import type {
  DatabaseCatalogWindow,
  DatabaseObjectItem,
  TableItem,
} from "src/types";
import { cn } from "src/utils/cn";
import { normalizeByteSizeLabel } from "src/utils/convert";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useInfiniteScroll } from "src/hooks/useInfiniteScroll";

const CATALOG_PAGE_SIZE = 100;

type CatalogColumn<T> = {
  key: string;
  label: string;
  className?: string;
  render: (row: T) => string;
};

const TABLE_COLUMNS: CatalogColumn<TableItem>[] = [
  {
    key: "name",
    label: "name",
    className: "min-w-56",
    render: (row) => row.name,
  },
  { key: "schema", label: "schema", render: (row) => row.schema },
  {
    key: "kind",
    label: "kind",
    render: (row) => (row.kind === "view" ? "VIEW" : "TABLE"),
  },
  { key: "owner", label: "owner", render: (row) => row.owner ?? "--" },
  {
    key: "estimated_row",
    label: "estimated_row",
    className: "text-right",
    render: (row) =>
      row.estimatedRow === undefined || row.estimatedRow === ""
        ? "--"
        : String(row.estimatedRow),
  },
  {
    key: "total_size",
    label: "total_size",
    className: "text-right",
    render: (row) => normalizeByteSizeLabel(row.totalSize),
  },
  {
    key: "data_size",
    label: "data_size",
    className: "text-right",
    render: (row) => normalizeByteSizeLabel(row.dataSize),
  },
  {
    key: "index_size",
    label: "index_size",
    className: "text-right",
    render: (row) => normalizeByteSizeLabel(row.indexSize),
  },
  { key: "comment", label: "comment", render: (row) => row.comment ?? "" },
];

const FUNCTION_COLUMNS: CatalogColumn<DatabaseObjectItem>[] = [
  {
    key: "name",
    label: "name",
    className: "min-w-56",
    render: (row) => row.name,
  },
  { key: "schema", label: "schema", render: (row) => row.schema },
  {
    key: "kind",
    label: "kind",
    render: (row) => row.kind.toUpperCase(),
  },
  {
    key: "signature",
    label: "signature",
    render: (row) => row.signature ?? "",
  },
  {
    key: "read_definition",
    label: "read_definition",
    render: (row) => (row.capability.canReadDefinition ? "YES" : "NO"),
  },
  {
    key: "edit",
    label: "edit",
    render: (row) => (row.capability.canEdit ? "YES" : "NO"),
  },
  {
    key: "delete",
    label: "delete",
    render: (row) => (row.capability.canDelete ? "YES" : "NO"),
  },
  {
    key: "reason",
    label: "comment",
    render: (row) => row.capability.reason ?? "",
  },
];

function CatalogTable<T>(props: {
  columns: CatalogColumn<T>[];
  rows: T[];
  resetKey: string;
  getRowKey: (row: T) => string;
  emptyLabel: string;
  renderNameIcon: (row: T) => ComponentChildren;
  onOpen: (row: T) => void;
}) {
  const {
    visibleItems: visibleRows,
    sentinelRef,
    hasMore,
  } = useInfiniteScroll(props.rows, {
    pageSize: CATALOG_PAGE_SIZE,
    resetKey: props.resetKey,
  });

  return (
    <OverlayScrollArea
      className="min-h-0 flex-1 bg-neutral-50"
      dataScrollRoot
      horizontal
      vertical
    >
      <table class="w-full min-w-max border-separate border-spacing-0 text-sm">
        <thead class="bg-neutral-50">
          <tr>
            {props.columns.map((column) => (
              <th
                key={column.key}
                class={cn(
                  "border-r border-b border-neutral-200",
                  "px-3 py-2 text-left text-sm font-semibold text-neutral-600",
                  "sticky top-0 z-10 bg-neutral-50 shadow-[0_1px_0_0_rgba(0,0,0,0.05)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.05)]",
                  column.className
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td
                colSpan={props.columns.length}
                class="px-4 py-10 text-center text-sm text-neutral-500"
              >
                {props.emptyLabel}
              </td>
            </tr>
          ) : (
            visibleRows.map((row) => (
              <tr
                key={props.getRowKey(row)}
                data-catalog-row
                onDblClick={() => props.onOpen(row)}
                class="cursor-default odd:bg-white even:bg-neutral-50 hover:bg-blue-100!"
              >
                {props.columns.map((column, columnIndex) => (
                  <td
                    key={column.key}
                    class={cn(
                      "max-w-80 truncate border-r border-b border-neutral-200 px-3 py-2 text-neutral-800",
                      column.className
                    )}
                    title={column.render(row)}
                  >
                    {columnIndex === 0 ? (
                      <div class="flex min-w-0 items-center gap-2">
                        {props.renderNameIcon(row)}
                        <span class="min-w-0 truncate">
                          {column.render(row)}
                        </span>
                      </div>
                    ) : (
                      column.render(row)
                    )}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {hasMore ? (
        <div ref={sentinelRef} class="h-px" aria-hidden="true" />
      ) : null}
    </OverlayScrollArea>
  );
}

export function DatabaseCatalogPane(props: { win: DatabaseCatalogWindow }) {
  const { win } = props;
  const rt = useConnectionRuntimeCtx();
  const actions = useConnectionActionsCtx();
  const { openDatabaseObjectsManager } = useConnectionWindows(rt.profileId);
  const [search, setSearch] = useState("");
  const schemaScope = win.schema?.trim() || "";

  const meta = rt.metadata.get({
    metaKey: rt.metaKey,
    engine: rt.engine,
    connectionId: rt.runtimeConnectionId,
    currentDatabase: rt.activeSchema,
    lazy: true,
  });

  const tableRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (meta.tables ?? []).filter((table) => {
      const effectiveSchema = schemaScope;
      if (effectiveSchema !== "all" && table.schema !== effectiveSchema)
        return false;
      if (!q) return true;
      return [table.name, table.schema, table.kind, table.owner, table.comment]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [meta.tables, schemaScope, search]);

  const functionRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (meta.objects ?? [])
      .filter((item): item is DatabaseObjectItem => item.kind === "function")
      .filter((item) => {
        const effectiveSchema = schemaScope;
        if (effectiveSchema !== "all" && item.schema !== effectiveSchema)
          return false;
        if (!q) return true;
        return [item.name, item.schema, item.signature, item.capability.reason]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q));
      });
  }, [meta.objects, schemaScope, search]);

  const isFunctions = win.catalogKind === "functions";
  const title = win.title?.trim() || (isFunctions ? "Functions" : "Tables");
  const rowsCount = isFunctions ? functionRows.length : tableRows.length;

  const refresh = async () => {
    if (!rt.runtimeConnectionId) return;
    await rt.metadata.refresh({
      metaKey: rt.metaKey,
      engine: rt.engine,
      connectionId: rt.runtimeConnectionId,
      currentDatabase: rt.activeSchema,
    });
  };

  return (
    <div class="flex h-full min-h-0 flex-col border-t border-neutral-200 bg-white">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            {isFunctions ? (
              <SquareFunctionIcon className="size-4 text-blue-500" />
            ) : (
              <TableIcon className="size-4 text-blue-500" />
            )}
            <h2 class="text-sm font-semibold text-neutral-900">{title}</h2>
          </div>
          <div class="mt-0.5 text-xs text-neutral-500">
            {schemaScope
              ? `${rowsCount} ${isFunctions ? "functions" : "tables"} in schema ${schemaScope}`
              : `${rowsCount} ${isFunctions ? "functions" : "tables"} in current metadata`}
          </div>
        </div>

        <div class="flex min-w-0 items-center gap-2">
          <div class="w-72">
            <Input
              value={search}
              onValueChange={setSearch}
              placeholder={`Search ${title.toLowerCase()}...`}
              left={<SearchIcon className="size-4 text-neutral-400" />}
              className="h-7 border border-neutral-200 pl-8"
            />
          </div>

          <Button
            type="button"
            variant="ghost"
            onClick={() => void refresh()}
            loading={meta.loading}
            className="h-7 border-neutral-200 px-1.5"
            title="Refresh metadata"
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
      </div>

      {meta.error ? (
        <div class="m-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {meta.error}
        </div>
      ) : isFunctions ? (
        <CatalogTable
          columns={FUNCTION_COLUMNS}
          rows={functionRows}
          resetKey={`functions\0${schemaScope}\0${search}\0${functionRows.length}`}
          getRowKey={(item) => item.id}
          emptyLabel="No functions found."
          renderNameIcon={() => (
            <SquareFunctionIcon className="size-4 shrink-0 text-blue-500" />
          )}
          onOpen={(item) =>
            openDatabaseObjectsManager({ kind: "function", object: item })
          }
        />
      ) : (
        <CatalogTable
          columns={TABLE_COLUMNS}
          rows={tableRows}
          resetKey={`tables\0${schemaScope}\0${search}\0${tableRows.length}`}
          getRowKey={(table) => `${table.schema}.${table.name}`}
          emptyLabel="No tables found."
          renderNameIcon={(table) => (
            <TableIcon
              className={cn(
                "size-4 shrink-0",
                table.kind === "view" ? "text-emerald-500" : "text-blue-500"
              )}
            />
          )}
          onOpen={(table) => void actions.selectTable(table)}
        />
      )}
    </div>
  );
}
