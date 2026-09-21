import { useCallback, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import {
  CanvasTable,
  type CanvasEditingCell,
} from "src/components/table/CanvasTable";
import { useContainerWidth } from "src/components/table/tableHooks";
import {
  EyeIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareFunctionIcon,
  TableIcon,
} from "src/components/icons";
import type { ColumnMeta } from "src/lib/tauri/types";
import type {
  DatabaseCatalogWindow,
  DatabaseObjectItem,
  TableItem,
} from "src/types";
import { normalizeByteSizeLabel } from "src/utils/convert";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionWindows } from "./hooks/useConnectionWindows";

type CatalogSort = { colName: string; direction: "asc" | "desc" } | null;

export type CatalogColumn<T> = {
  key: string;
  label: string;
  width?: number;
  render: (row: T) => string;
};

export const TABLE_COLUMNS: CatalogColumn<TableItem>[] = [
  { key: "name", label: "name", width: 220, render: (row) => row.name },
  { key: "schema", label: "schema", width: 120, render: (row) => row.schema },
  {
    key: "kind",
    label: "kind",
    width: 90,
    render: (row) => (row.kind === "view" ? "VIEW" : "TABLE"),
  },
  {
    key: "owner",
    label: "owner",
    width: 140,
    render: (row) => row.owner ?? "--",
  },
  {
    key: "estimated_row",
    label: "estimated_row",
    width: 130,
    render: (row) =>
      row.estimatedRow === undefined || row.estimatedRow === ""
        ? "--"
        : String(row.estimatedRow),
  },
  {
    key: "total_size",
    label: "total_size",
    width: 110,
    render: (row) => normalizeByteSizeLabel(row.totalSize),
  },
  {
    key: "data_size",
    label: "data_size",
    width: 110,
    render: (row) => normalizeByteSizeLabel(row.dataSize),
  },
  {
    key: "index_size",
    label: "index_size",
    width: 110,
    render: (row) => normalizeByteSizeLabel(row.indexSize),
  },
  {
    key: "comment",
    label: "comment",
    width: 240,
    render: (row) => row.comment ?? "",
  },
];

export const FUNCTION_COLUMNS: CatalogColumn<DatabaseObjectItem>[] = [
  { key: "name", label: "name", width: 220, render: (row) => row.name },
  { key: "schema", label: "schema", width: 120, render: (row) => row.schema },
  {
    key: "kind",
    label: "kind",
    width: 110,
    render: (row) => row.kind.toUpperCase(),
  },
  {
    key: "signature",
    label: "signature",
    width: 280,
    render: (row) => row.signature ?? "",
  },
  {
    key: "read_definition",
    label: "read_definition",
    width: 140,
    render: (row) => (row.capability.canReadDefinition ? "YES" : "NO"),
  },
  {
    key: "edit",
    label: "edit",
    width: 80,
    render: (row) => (row.capability.canEdit ? "YES" : "NO"),
  },
  {
    key: "delete",
    label: "delete",
    width: 80,
    render: (row) => (row.capability.canDelete ? "YES" : "NO"),
  },
  {
    key: "reason",
    label: "comment",
    width: 240,
    render: (row) => row.capability.reason ?? "",
  },
];

export function catalogRowValues<T>(
  row: T,
  columns: CatalogColumn<T>[]
): unknown[] {
  return columns.map((column) => column.render(row));
}

export function sortCatalogRows<T>(
  rows: T[],
  columns: CatalogColumn<T>[],
  sort: CatalogSort
): T[] {
  if (!sort) return rows;
  const column = columns.find((item) => item.label === sort.colName);
  if (!column) return rows;
  const next = [...rows];
  next.sort((a, b) => {
    const result = String(column.render(a) ?? "").localeCompare(
      String(column.render(b) ?? ""),
      undefined,
      { numeric: true }
    );
    return sort.direction === "asc" ? result : -result;
  });
  return next;
}

function CatalogCanvasTable<T>(props: {
  columns: CatalogColumn<T>[];
  rows: T[];
  resetKey: string;
  emptyLabel: string;
  onOpen: (row: T) => void;
  onRefresh: () => void;
}) {
  const [sort, setSort] = useState<CatalogSort>(null);
  const [selected, setSelected] = useState<CanvasEditingCell | null>(null);
  const [selectedRows, setSelectedRows] = useState(new Set<number>());
  const [anchor, setAnchor] = useState<number | null>(null);
  const { containerRef, containerWidth } = useContainerWidth();

  const canvasColumns = useMemo<ColumnMeta[]>(
    () =>
      props.columns.map((column) => ({
        name: column.label,
        db_type: "text",
        readonly: true,
      })),
    [props.columns]
  );

  const sortedRows = useMemo(
    () => sortCatalogRows(props.rows, props.columns, sort),
    [props.columns, props.rows, sort]
  );

  const widthByName = useMemo(() => {
    const widths: Record<string, number> = {};
    for (const column of props.columns) {
      widths[column.label] = column.width ?? 160;
    }
    return widths;
  }, [props.columns]);

  const columnsWidth = useMemo(
    () => Object.values(widthByName).reduce((sum, width) => sum + width, 0),
    [widthByName]
  );
  const emptyColumnWidth = Math.max(
    0,
    Math.max(1, containerWidth) - columnsWidth
  );

  const getRowAt = useCallback(
    (index: number) => {
      const row = sortedRows[index];
      return row ? catalogRowValues(row, props.columns) : undefined;
    },
    [props.columns, sortedRows]
  );

  const projection = `${props.resetKey}\0${sort?.colName ?? ""}\0${sort?.direction ?? ""}`;
  const [previousProjection, setPreviousProjection] = useState(projection);
  if (projection !== previousProjection) {
    setPreviousProjection(projection);
    setSelected(null);
    setSelectedRows(new Set());
    setAnchor(null);
  }

  const clearSelection = () => {
    setSelected(null);
    setSelectedRows(new Set());
    setAnchor(null);
  };

  return (
    <div ref={containerRef} class="relative min-h-0 flex-1 bg-white">
      <CanvasTable
        viewKey={projection}
        columns={canvasColumns}
        totalRows={sortedRows.length}
        getRowAt={getRowAt}
        widthByName={widthByName}
        emptyColumnWidth={emptyColumnWidth}
        dataVersion={sortedRows.length}
        sortState={sort}
        onChangeSort={setSort}
        selected={selected}
        selectedRows={selectedRows}
        onSelect={(rowIdx, colIdx, multi, range) => {
          if (!sortedRows[rowIdx]) return;
          setSelected({ rowIdx, colIdx });
          setSelectedRows((previous) => {
            const next = multi || range ? new Set(previous) : new Set<number>();
            if (range && anchor !== null) {
              for (
                let i = Math.min(anchor, rowIdx);
                i <= Math.max(anchor, rowIdx);
                i++
              )
                next.add(i);
            } else if (multi && next.has(rowIdx)) next.delete(rowIdx);
            else next.add(rowIdx);
            return next;
          });
          if (!range) setAnchor(rowIdx);
        }}
        onClearSelection={clearSelection}
        onSelectAllRows={() => {
          setSelectedRows(new Set(sortedRows.map((_, index) => index)));
          setSelected(sortedRows.length ? { rowIdx: 0, colIdx: 0 } : null);
          setAnchor(0);
        }}
        onActivateRow={(rowIdx) => {
          const row = sortedRows[rowIdx];
          if (row) props.onOpen(row);
        }}
        onRefresh={props.onRefresh}
      />
      {props.rows.length === 0 ? (
        <div class="pointer-events-none absolute inset-x-0 top-7 px-4 text-center text-sm text-neutral-500">
          {props.emptyLabel}
        </div>
      ) : null}
    </div>
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
    const wantViews = win.catalogKind === "views";
    return (meta.tables ?? []).filter((table) => {
      const isView = table.kind === "view";
      if (wantViews ? !isView : isView) return false;
      const effectiveSchema = schemaScope;
      if (effectiveSchema !== "all" && table.schema !== effectiveSchema)
        return false;
      if (!q) return true;
      return [table.name, table.schema, table.kind, table.owner, table.comment]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [meta.tables, schemaScope, search, win.catalogKind]);

  const objectKind =
    win.catalogKind === "functions"
      ? ("function" as const)
      : win.catalogKind === "procedures"
        ? ("procedure" as const)
        : win.catalogKind === "triggers"
          ? ("trigger" as const)
          : null;

  const objectRows = useMemo(() => {
    if (!objectKind) return [] as DatabaseObjectItem[];
    const q = search.trim().toLowerCase();
    return (meta.objects ?? [])
      .filter((item): item is DatabaseObjectItem => item.kind === objectKind)
      .filter((item) => {
        const effectiveSchema = schemaScope;
        if (effectiveSchema !== "all" && item.schema !== effectiveSchema)
          return false;
        if (!q) return true;
        return [item.name, item.schema, item.signature, item.capability.reason]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q));
      });
  }, [meta.objects, objectKind, schemaScope, search]);

  const isObjectCatalog = objectKind !== null;
  const objectLabel =
    win.catalogKind === "functions"
      ? "functions"
      : win.catalogKind === "procedures"
        ? "procedures"
        : win.catalogKind === "triggers"
          ? "triggers"
          : win.catalogKind === "views"
            ? "views"
            : "tables";
  const title =
    win.title?.trim() ||
    (win.catalogKind === "tables"
      ? "Tables"
      : win.catalogKind === "views"
        ? "Views"
        : win.catalogKind === "functions"
          ? "Functions"
          : win.catalogKind === "procedures"
            ? "Procedures"
            : "Triggers");
  const rowsCount = isObjectCatalog ? objectRows.length : tableRows.length;

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
            {isObjectCatalog ? (
              <SquareFunctionIcon className="size-4 text-blue-500" />
            ) : win.catalogKind === "views" ? (
              <EyeIcon className="size-4 text-blue-500" />
            ) : (
              <TableIcon className="size-4 text-blue-500" />
            )}
            <h2 class="text-sm font-semibold text-neutral-900">{title}</h2>
          </div>
          <div class="mt-0.5 text-xs text-neutral-500">
            {schemaScope
              ? `${rowsCount} ${objectLabel} in schema ${schemaScope}`
              : `${rowsCount} ${objectLabel} in current metadata`}
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
      ) : isObjectCatalog && objectKind ? (
        <CatalogCanvasTable
          columns={FUNCTION_COLUMNS}
          rows={objectRows}
          resetKey={`${win.catalogKind}\0${schemaScope}\0${search}\0${objectRows.length}`}
          emptyLabel={`No ${objectLabel} found.`}
          onOpen={(item) =>
            openDatabaseObjectsManager({ kind: objectKind, object: item })
          }
          onRefresh={() => void refresh()}
        />
      ) : (
        <CatalogCanvasTable
          columns={TABLE_COLUMNS}
          rows={tableRows}
          resetKey={`${win.catalogKind}\0${schemaScope}\0${search}\0${tableRows.length}`}
          emptyLabel={
            win.catalogKind === "views" ? "No views found." : "No tables found."
          }
          onOpen={(table) => void actions.selectTable(table)}
          onRefresh={() => void refresh()}
        />
      )}
    </div>
  );
}
