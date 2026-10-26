import { useMemo, useState } from "preact/hooks";
import {
  CanvasTable,
  canvasTableHeightForRows,
} from "src/components/table/CanvasTable";
import {
  useColumnSizing,
  useContainerWidth,
} from "src/components/table/tableHooks";
import type { ColumnMeta } from "src/lib/tauri/types";

/**
 * Read-only preview of the rows an import will insert, in the same canvas
 * grid as table data: one column per mapped table column, values as they
 * will be written (null shown as NULL). Sized to its rows, no editing.
 */
export function ImportPreviewGrid(props: {
  columns: ColumnMeta[];
  rows: Record<string, string | null>[];
}) {
  const { columns, rows } = props;
  const canvasColumns = useMemo<ColumnMeta[]>(
    () => columns.map((col) => ({ ...col, readonly: true })),
    [columns]
  );
  const { widthByName, totalWidth, columnsKey } =
    useColumnSizing(canvasColumns);
  const { containerRef, containerWidth } = useContainerWidth();
  const [selected, setSelected] = useState<{
    rowIdx: number;
    colIdx: number;
  } | null>(null);

  const values = useMemo(
    () => rows.map((row) => canvasColumns.map((col) => row[col.name] ?? null)),
    [rows, canvasColumns]
  );
  const height = canvasTableHeightForRows(rows.length);

  return (
    // The frame draws all four edges. The grid sits 1px outside it on
    // every side, so its own edge lines fall under the frame and are
    // clipped: one line everywhere, including beside the header.
    <div
      class="relative overflow-hidden rounded-lg border border-neutral-200 bg-white"
      data-testid="import-preview-grid"
    >
      {/* The same rows as text for screen readers; the canvas is visual
          only and stays out of the Tab order. */}
      <table class="sr-only">
        <caption>Rows to insert</caption>
        <thead>
          <tr>
            {canvasColumns.map((col) => (
              <th key={col.name} scope="col">
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {values.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {row.map((value, colIdx) => (
                <td key={colIdx}>{value === null ? "NULL" : value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div
        ref={containerRef}
        class="-m-px"
        style={{ height }}
        aria-hidden="true"
      >
        <CanvasTable
          viewKey={columnsKey}
          columns={canvasColumns}
          totalRows={values.length}
          getRowAt={(index) => values[index]}
          widthByName={widthByName}
          emptyColumnWidth={Math.max(0, containerWidth - totalWidth)}
          dataVersion={values.length}
          selected={selected}
          onSelect={(rowIdx, colIdx) => setSelected({ rowIdx, colIdx })}
          onClearSelection={() => setSelected(null)}
          addRowOnBlankDoubleClick={false}
          focusable={false}
        />
      </div>
    </div>
  );
}
