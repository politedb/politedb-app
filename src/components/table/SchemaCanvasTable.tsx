import { useMemo, useState } from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import {
  CanvasTable,
  type CanvasCellOption,
  type CanvasEditingCell,
} from "./CanvasTable";

export interface SchemaCanvasColumn<T> {
  key: Extract<keyof T, string>;
  options?: CanvasCellOption[];
  width?: number;
  action?: (sourceIndex: number) => void;
}

interface Props<T> {
  rows: T[];
  columns: SchemaCanvasColumn<T>[];
  searchQuery?: string;
  readOnly?: boolean;
  deletedRows?: Set<number>;
  isNewRow?: (sourceIndex: number) => boolean;
  isCellDirty?: (sourceIndex: number, key: Extract<keyof T, string>) => boolean;
  getValue?: (
    row: T,
    key: Extract<keyof T, string>,
    sourceIndex: number
  ) => unknown;
  onChange: (
    sourceIndex: number,
    key: Extract<keyof T, string>,
    value: string
  ) => void;
  onDelete?: (sourceIndex: number) => void;
  onAdd?: () => void;
}

type Sort = { colName: string; direction: "asc" | "desc" } | null;

// Keep source indices attached to the projection; canvas indices are view-local.
export function SchemaCanvasTable<T>({
  rows,
  columns,
  searchQuery = "",
  readOnly = false,
  deletedRows,
  isNewRow,
  isCellDirty,
  getValue,
  onChange,
  onDelete,
  onAdd,
}: Props<T>) {
  const [sort, setSort] = useState<Sort>(null);
  const [selected, setSelected] = useState<CanvasEditingCell | null>(null);
  const [selectedRows, setSelectedRows] = useState(new Set<number>());
  const [editing, setEditing] = useState<CanvasEditingCell | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);

  const view = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const projected = rows
      .map((row, sourceIndex) => ({
        sourceIndex,
        values: [
          sourceIndex + 1,
          ...columns.map(({ key }) =>
            getValue ? getValue(row, key, sourceIndex) : row[key]
          ),
        ],
      }))
      .filter(
        ({ values }) =>
          !query ||
          values.slice(1).some((value) =>
            String(value ?? "")
              .toLowerCase()
              .includes(query)
          )
      );
    if (sort) {
      const index =
        sort.colName === "#"
          ? 0
          : columns.findIndex((col) => col.key === sort.colName) + 1;
      projected.sort((a, b) => {
        const result =
          index === 0
            ? a.sourceIndex - b.sourceIndex
            : String(a.values[index] ?? "").localeCompare(
                String(b.values[index] ?? ""),
                undefined,
                { numeric: true }
              );
        return sort.direction === "asc" ? result : -result;
      });
    }
    return projected;
  }, [rows, columns, getValue, searchQuery, sort]);

  // A changed projection invalidates view-local selection and any open editor.
  const projection = `${readOnly}:${columns.map((column) => column.key).join(",")}:${view.map((row) => row.sourceIndex).join(",")}`;
  const [previousProjection, setPreviousProjection] = useState(projection);
  if (projection !== previousProjection) {
    setPreviousProjection(projection);
    setSelected(null);
    setSelectedRows(new Set());
    setEditing(null);
    setAnchor(null);
  }

  const canvasColumns = useMemo<ColumnMeta[]>(
    () => [
      { name: "#", db_type: "text", readonly: true },
      ...columns.map((col) => ({
        name: col.key,
        db_type: "text",
        readonly: readOnly,
      })),
    ],
    [columns, readOnly]
  );
  const widths = useMemo(
    () =>
      Object.fromEntries([
        ["#", 52],
        ...columns.map((col) => [col.key, col.width ?? 200]),
      ]),
    [columns]
  );
  const options = useMemo(
    () =>
      Object.fromEntries(
        columns
          .filter((col) => col.options)
          .map((col) => [col.key, col.options!])
      ),
    [columns]
  );
  const actions = useMemo(
    () => columns.filter((col) => col.action).map((col) => col.key),
    [columns]
  );
  const canvasDeleted = useMemo(
    () =>
      new Set(
        view.flatMap((row, index) =>
          deletedRows?.has(row.sourceIndex) ? [index] : []
        )
      ),
    [view, deletedRows]
  );
  const getRowAt = useMemo(
    () => (index: number) => view[index]?.values,
    [view]
  );
  const clearSelection = () => {
    setSelected(null);
    setSelectedRows(new Set());
    setAnchor(null);
  };
  const canEdit = (cell: CanvasEditingCell) =>
    !readOnly &&
    !!view[cell.rowIdx] &&
    cell.colIdx > 0 &&
    !canvasDeleted.has(cell.rowIdx);

  return (
    <CanvasTable
      viewKey={projection}
      columns={canvasColumns}
      totalRows={view.length}
      getRowAt={getRowAt}
      widthByName={widths}
      emptyColumnWidth={0}
      dataVersion={0}
      cellOptions={options}
      actionColumns={actions}
      sortState={sort}
      onChangeSort={setSort}
      selected={selected}
      selectedRows={selectedRows}
      editing={editing && canEdit(editing) ? editing : null}
      deletedRows={canvasDeleted}
      isNewRow={(index) =>
        !!view[index] && !!isNewRow?.(view[index].sourceIndex)
      }
      isCellDirty={(index, name) =>
        !!view[index] &&
        name !== "#" &&
        !!isCellDirty?.(
          view[index].sourceIndex,
          name as Extract<keyof T, string>
        )
      }
      onSelect={(rowIdx, colIdx, multi, range) => {
        if (!view[rowIdx]) return;
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
        setSelectedRows(new Set(view.map((_, index) => index)));
        setSelected(view.length ? { rowIdx: 0, colIdx: 1 } : null);
        setAnchor(0);
      }}
      onStartEdit={
        readOnly
          ? undefined
          : (cell) => {
              if (canEdit(cell)) setEditing(cell);
            }
      }
      onExitEdit={() => setEditing(null)}
      onCommitEdit={
        readOnly
          ? undefined
          : (cell, value) => {
              const column = columns[cell.colIdx - 1];
              if (!canEdit(cell) || !column || column.action) return;
              onChange(
                view[cell.rowIdx].sourceIndex,
                column.key,
                value == null ? "" : String(value)
              );
              setEditing(null);
            }
      }
      onCellActivate={(cell) => {
        const column = columns[cell.colIdx - 1];
        if (!canEdit(cell) || !column?.action) return false;
        setEditing(null);
        column.action(view[cell.rowIdx].sourceIndex);
        return true;
      }}
      onAddRow={readOnly || searchQuery.trim() ? undefined : onAdd}
      onDeleteRows={
        readOnly || !onDelete
          ? undefined
          : (indices) => {
              // New-table deletion splices the array, so remove highest source index first.
              const sources = new Set(
                indices.flatMap((index) =>
                  view[index] && !canvasDeleted.has(index)
                    ? [view[index].sourceIndex]
                    : []
                )
              );
              [...sources]
                .sort((a, b) => b - a)
                .forEach((index) => onDelete(index));
              setEditing(null);
              clearSelection();
            }
      }
    />
  );
}
