import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import { cellToString } from "src/utils/convert";
import { ChevronDownIcon, ChevronUpIcon } from "src/components/icons";
import { cn } from "src/utils/cn";
import type { DatabaseEngine, TableForeignKey } from "src/types";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import {
  formatSqlValue,
  isBlobColumnType,
  isJsonColumnType,
  quoteIdentifier,
  quoteTableName,
} from "src/utils/sqlDialect";
import { useTableFocusState } from "src/hooks/useTableFocusState";
import { defaultCellEditValue } from "src/lib/table-data/cellEditValue";
import { openDialog } from "src/lib/system-dialog";
import { readFile } from "src/lib/system-fs";
import { formatTableCellValue } from "./tableCellValue";
import { tableCellBackground } from "./tableCellBackground";

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 28;
const ACTIVE_CELL_STROKE_FOCUSED = "#0000ff";
const ACTIVE_CELL_STROKE_UNFOCUSED = "#9ca3af";
const SELECTED_TEXT_UNFOCUSED = "#6b7280";

type EditingCell = { rowIdx: number; colIdx: number };
type HeaderMenuState = { x: number; y: number; colName: string };
type RowMenuState = {
  x: number;
  y: number;
  rowIdx: number;
  colIdx: number;
  value: string;
};
type CellEditorKind = "text" | "json" | "date" | "datetime" | "bool" | "blob";
const ROW_CLIPBOARD_PREFIX = "POLITEDB_ROWS:";

type Props = {
  columns: ColumnMeta[];
  totalRows: number;
  getRowAt: (rowIndex: number) => unknown[] | undefined;
  isCellDirty?: (rowIdx: number, colName: string) => boolean;
  isNewRow?: (rowIdx: number) => boolean;

  widthByName: Record<string, number>;
  emptyColumnWidth: number;

  // Optional external sort state, used for sortable headers.
  sortState?: { colName: string; direction: "asc" | "desc" } | null;

  selected?: { rowIdx: number; colIdx: number } | null;
  selectedRows?: Set<number>;
  editing?: EditingCell | null;
  deletedRows?: Set<number>;

  dataVersion: number;

  foreignKeyMap?: Record<string, TableForeignKey>;

  onSelect?: (
    rowIdx: number,
    colIdx: number,
    multi?: boolean,
    range?: boolean
  ) => void;
  onStartEdit?: (cell: EditingCell) => void;
  onCommitEdit?: (cell: EditingCell, value: unknown) => void;
  onExitEdit?: () => void;

  onCellActivate?: (cell: EditingCell) => boolean | void;

  // Called when user clicks a column header to change sort.
  onChangeSort?: (
    sort: { colName: string; direction: "asc" | "desc" } | null
  ) => void;

  onDeleteRow?: (rowIdx: number) => void;
  onDeleteRows?: (rowIndices: number[]) => void;
  onAddRow?: () => void;
  onDuplicateRow?: (rowIdx: number) => void;
  onRefresh?: () => void;
  onExportCurrentPage?: () => void;
  onImportData?: () => void;
  onPasteRows?: (rows: unknown[][], sourceColumns?: string[]) => void;
  onQuickFilter?: (colName: string, value: string) => void;
  schema?: string;
  tableName?: string;
  engine?: DatabaseEngine;
  onClearSelection?: () => void;
  onSelectAllRows?: () => void;
};

// ============================================================================
// Utils
// ============================================================================

/** Truncate text with ellipsis to fit within maxWidth when drawn with ctx. */
function ellipsize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (maxWidth <= 0) return "";
  const full = ctx.measureText(text).width;
  if (full <= maxWidth) return text;
  const ellipsis = "...";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  const usable = maxWidth - ellipsisWidth;
  if (usable <= 0) return ellipsis;
  let lo = 0;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const part = text.slice(0, mid);
    if (ctx.measureText(part).width <= usable) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, best) + ellipsis;
}

function sumWidths(
  cols: ColumnMeta[],
  widthByName: Record<string, number>,
  empty: number
) {
  let w = 0;
  for (const c of cols) w += widthByName[c.name] ?? 140;
  return w + Math.max(0, empty);
}

function buildColLefts(
  cols: ColumnMeta[],
  widthByName: Record<string, number>
) {
  const lefts: number[] = new Array(cols.length);
  let x = 0;
  for (let i = 0; i < cols.length; i++) {
    lefts[i] = x;
    x += widthByName[cols[i]!.name] ?? 140;
  }
  return lefts;
}

function getVisibleColRange(
  cols: ColumnMeta[],
  lefts: number[],
  widthByName: Record<string, number>,
  scrollLeft: number,
  viewportWidth: number
) {
  if (cols.length === 0) return { start: 0, end: -1 };

  const visibleLeft = scrollLeft;
  const visibleRight = scrollLeft + viewportWidth;

  let lo = 0;
  let hi = cols.length - 1;
  let start = cols.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const right = (lefts[mid] ?? 0) + (widthByName[cols[mid]!.name] ?? 140);
    if (right >= visibleLeft) {
      start = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  lo = 0;
  hi = cols.length - 1;
  let end = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const colLeft = lefts[mid] ?? 0;
    if (colLeft <= visibleRight) {
      end = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (start > end) return { start: 0, end: -1 };
  return { start, end };
}

function hitTestCol(
  x: number,
  cols: ColumnMeta[],
  lefts: number[],
  widthByName: Record<string, number>
) {
  // Linear scan is acceptable for < 100 columns.
  for (let i = 0; i < cols.length; i++) {
    const w = widthByName[cols[i]!.name] ?? 140;
    const l = lefts[i]!;
    if (x >= l && x < l + w) return i;
  }
  return -1;
}

function formatCellForClipboard(value: unknown): string {
  const text = cellToString(value, true);
  if (text === null) return "NULL";
  if (text === "") return "EMPTY";
  return text;
}

function formatCellForCsv(value: unknown): string {
  const text = cellToString(value, true);
  if (text === null) return "NULL";
  if (text === "") return '""';
  return escapeCsvCell(text);
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
}

function getRowObjects(columns: ColumnMeta[], rows: unknown[][]) {
  return rows.map((row) => {
    const obj: Record<string, string | null> = {};
    columns.forEach((col, idx) => {
      obj[col.name] = cellToString(row[idx], true);
    });
    return obj;
  });
}

function serializeRowsForInternalClipboard(
  columns: ColumnMeta[],
  rows: unknown[][]
): string {
  return `${ROW_CLIPBOARD_PREFIX}${JSON.stringify({
    version: 1,
    columns: columns.map((col) => col.name),
    rows,
  })}`;
}

function parseRowsFromInternalClipboard(text: string): {
  columns?: string[];
  rows: unknown[][];
} | null {
  if (!text.startsWith(ROW_CLIPBOARD_PREFIX)) return null;
  try {
    const payload = JSON.parse(text.slice(ROW_CLIPBOARD_PREFIX.length));
    if (!payload || !Array.isArray(payload.rows)) return null;
    const rows = payload.rows.filter((row: unknown): row is unknown[] =>
      Array.isArray(row)
    );
    if (!rows.length) return null;
    const sourceColumns = Array.isArray(payload.columns)
      ? payload.columns.filter(
          (name: unknown): name is string => typeof name === "string"
        )
      : undefined;
    return { columns: sourceColumns, rows };
  } catch {
    return null;
  }
}

function formatRowsForClipboard(args: {
  format:
    | "plain"
    | "json"
    | "html"
    | "markdown"
    | "csv"
    | "csv-header"
    | "insert";
  columns: ColumnMeta[];
  rows: unknown[][];
  schema?: string;
  tableName?: string;
  engine?: DatabaseEngine;
}) {
  const { format, columns, rows, schema = "", tableName = "", engine } = args;
  const names = columns.map((col) => col.name);
  const values = rows.map((row) =>
    columns.map((_col, idx) => formatCellForClipboard(row[idx]))
  );
  const csvValues = rows.map((row) =>
    columns.map((_col, idx) => formatCellForCsv(row[idx]))
  );

  if (format === "plain") {
    return values.map((row) => row.join("\t")).join("\n");
  }

  if (format === "json") {
    return JSON.stringify(getRowObjects(columns, rows), null, 2);
  }

  if (format === "html") {
    const head = names.map((name) => `<th>${escapeHtml(name)}</th>`).join("");
    const body = values
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`
      )
      .join("");
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  if (format === "markdown") {
    const header = `| ${names.map(escapeMarkdownCell).join(" | ")} |`;
    const divider = `| ${names.map(() => "---").join(" | ")} |`;
    const body = values.map(
      (row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`
    );
    return [header, divider, ...body].join("\n");
  }

  if (format === "csv" || format === "csv-header") {
    const lines = csvValues.map((row) => row.join(","));
    if (format === "csv-header") {
      lines.unshift(names.map(escapeCsvCell).join(","));
    }
    return lines.join("\n");
  }

  const table = tableName
    ? quoteTableName(schema, tableName, engine)
    : quoteIdentifier("table_name", engine);
  const colList = names.map((name) => quoteIdentifier(name, engine)).join(", ");
  const rowValues = rows
    .map(
      (row) =>
        `  (${columns
          .map((col, idx) => formatSqlValue(row[idx], col.db_type, engine))
          .join(", ")})`
    )
    .join(",\n");
  return `INSERT INTO ${table} (${colList}) VALUES\n${rowValues};`;
}

function getCellEditorKind(column?: ColumnMeta): CellEditorKind {
  const type = column?.db_type?.toLowerCase() ?? "";
  if (isBlobColumnType(type)) return "blob";
  if (isJsonColumnType(type)) return "json";
  if (/\b(bool|boolean|bit)\b/.test(type)) return "bool";
  if (
    /\b(timestamp|datetime|timestamptz|timestamp with time zone)\b/.test(type)
  ) {
    return "datetime";
  }
  if (/\b(date)\b/.test(type)) return "date";
  return "text";
}

function toDateInputValue(value: string, kind: CellEditorKind) {
  if (!value) return "";
  if (kind === "date") {
    return value.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
  }
  return value;
}

function fromDateInputValue(value: string, _kind: CellEditorKind) {
  if (!value) return "";
  return value;
}

export const __testToDateInputValue = toDateInputValue;
export const __testFromDateInputValue = fromDateInputValue;

// ============================================================================
// Main Component
// ============================================================================

export function CanvasTable({
  columns,
  totalRows,
  widthByName = {}, // Default empty if not provided
  emptyColumnWidth,
  selected,
  selectedRows,
  editing,
  deletedRows,
  dataVersion,
  sortState,
  foreignKeyMap,
  getRowAt,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onExitEdit,
  onDeleteRow,
  onDeleteRows,
  onAddRow,
  onDuplicateRow,
  onRefresh,
  onExportCurrentPage,
  onImportData,
  onPasteRows,
  onQuickFilter,
  schema,
  tableName,
  engine,
  onClearSelection,
  onSelectAllRows,
  isCellDirty,
  isNewRow,
  onChangeSort,
  onCellActivate,
}: Props) {
  // --- Refs for DOM elements ---
  const { ref: rootCallbackRef, rootRef, isFocused } = useTableFocusState();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // --- INTERNAL STATE FOR COLUMNS ---
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => ({
    ...widthByName,
  }));

  // Sync widthByName if prop changes (optional)
  useEffect(() => {
    setColWidths((prev) => ({ ...prev, ...widthByName }));
  }, [widthByName]);

  // --- Optimization: Scroll State via Refs ---
  const scrollRef = useRef({ top: 0, left: 0 });
  const rafRef = useRef<number | null>(null);
  const textCacheRef = useRef<Map<string, string>>(new Map());
  const cellTextCacheRef = useRef<Map<string, { raw: unknown; text: string }>>(
    new Map()
  );

  // --- Resize State ---
  const resizingRef = useRef<{
    colName: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  // --- Editor State ---
  const editorRef = useRef<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(null);
  const [editorValue, setEditorValue] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorRect, setEditorRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuState | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  const editorKind = editing
    ? getCellEditorKind(columns[editing.colIdx])
    : "text";

  // --- Viewport ---
  const [viewport, setViewport] = useState({ w: 1, h: 1 });
  const viewportRef = useRef(viewport);

  // --- Memoized Computations (Using colWidths state) ---
  const totalWidth = useMemo(
    () => sumWidths(columns, colWidths, emptyColumnWidth),
    [columns, colWidths, emptyColumnWidth]
  );

  const colLefts = useMemo(
    () => buildColLefts(columns, colWidths),
    [columns, colWidths]
  );

  const bodyH = Math.max(1, viewport.h - HEADER_HEIGHT);

  // --------------------------------------------------------------------------
  // DRAW FUNCTION (Uses colWidths state)
  // --------------------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;

    const { top, left } = scrollRef.current;

    const firstRow = Math.max(0, Math.floor(top / ROW_HEIGHT));
    const visibleCount = Math.ceil(bodyH / ROW_HEIGHT) + 2;
    const lastRow = Math.min(totalRows, firstRow + visibleCount);

    // 1. Clear
    ctx.clearRect(0, 0, viewport.w, bodyH);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, viewport.w, bodyH);

    // 2. Zebra
    {
      const startY = -(top % ROW_HEIGHT || 0);
      for (let y = startY; y < bodyH; y += ROW_HEIGHT) {
        const absoluteRowIdx = Math.floor((top + y) / ROW_HEIGHT);
        if ((absoluteRowIdx & 1) === 1) {
          ctx.fillStyle = "#fafafa";
          ctx.fillRect(0, y, viewport.w, ROW_HEIGHT);
        }
      }
    }

    // 3. Grid Lines
    ctx.beginPath();
    ctx.strokeStyle = "#e5e5e5";

    // Horizontal
    const startY = -(top % ROW_HEIGHT || 0);
    for (let y = startY; y <= bodyH; y += ROW_HEIGHT) {
      const yy = Math.floor(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(viewport.w, yy);
    }

    // Vertical
    ctx.strokeStyle = "#e5e5e5";
    ctx.moveTo(0.5, 0);
    ctx.lineTo(0.5, bodyH);

    const visibleCols = getVisibleColRange(
      columns,
      colLefts,
      colWidths,
      left,
      viewport.w
    );

    for (let c = visibleCols.start; c <= visibleCols.end; c++) {
      const col = columns[c]!;
      const x = (colLefts[c] ?? 0) - left;
      const w = colWidths[col.name] ?? 140; // Use state
      const xr = x + w;

      if (xr < 0 || x > viewport.w) continue;

      // Match CSS `border-right` on header cells (inside each box).
      const xx = Math.floor(xr - 1) + 0.5;
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, bodyH);
    }
    ctx.moveTo(viewport.w - 0.5, 0);
    ctx.lineTo(viewport.w - 0.5, bodyH);
    ctx.stroke();

    // 4. Content
    ctx.font = "400 13px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textBaseline = "middle";

    for (let r = firstRow; r < lastRow; r++) {
      const y = r * ROW_HEIGHT - top;
      const row = getRowAt(r);
      if (!row) continue;

      for (let c = visibleCols.start; c <= visibleCols.end; c++) {
        const col = columns[c]!;
        const x = (colLefts[c] ?? 0) - left;
        const w = colWidths[col.name] ?? 140; // Use state

        if (x + w < 0 || x > viewport.w) continue;

        const v = row[c] ?? null;
        const valueKey = `${r}|${c}`;
        const cached = cellTextCacheRef.current.get(valueKey);
        let s = cached?.text;
        if (!cached || !Object.is(cached.raw, v)) {
          s = formatTableCellValue(v, col.db_type) || "NULL";
          if (cellTextCacheRef.current.size > 50000) {
            cellTextCacheRef.current.clear();
          }
          cellTextCacheRef.current.set(valueKey, { raw: v, text: s });
        }

        const dirty = !!isCellDirty?.(r, col.name);
        const isRowSelected =
          selectedRows?.has(r) || (selected && selected.rowIdx === r);
        const background = tableCellBackground({
          dirty,
          deleted: !!deletedRows?.has(r),
          newRow: !!isNewRow?.(r),
          selected: !!isRowSelected,
          focused: isFocused,
        });

        if (background) {
          ctx.fillStyle = background;
          ctx.fillRect(x, y + 1, w - 1, ROW_HEIGHT - 1);
        }

        if (isRowSelected) {
          if (selected && selected.colIdx === c && selected.rowIdx === r) {
            ctx.strokeStyle = isFocused
              ? ACTIVE_CELL_STROKE_FOCUSED
              : ACTIVE_CELL_STROKE_UNFOCUSED;
            ctx.strokeRect(x + 1, y + 1, w - 2, ROW_HEIGHT - 1);
          }
        }

        if (s) {
          const isFkCol = !!foreignKeyMap && !!foreignKeyMap[col.name];
          const arrowWidth = isFkCol ? 14 : 0;
          const maxTextWidth = Math.max(0, w - 16 - arrowWidth);
          const cacheKey = `${maxTextWidth}|${s}`;
          let displayText = textCacheRef.current.get(cacheKey);
          if (!displayText) {
            displayText = ellipsize(ctx, s, maxTextWidth);
            if (textCacheRef.current.size > 10000) {
              textCacheRef.current.clear();
            }
            textCacheRef.current.set(cacheKey, displayText);
          }

          const textColor =
            s === "NULL"
              ? "#9ca3af"
              : isRowSelected && !isFocused
                ? SELECTED_TEXT_UNFOCUSED
                : "#111827";

          // Draw FK arrow on the right side of the cell (thin right arrow)
          if (isFkCol && s !== "NULL") {
            const centerY = y + ROW_HEIGHT / 2;
            const arrowRight = x + w - 8;
            const arrowLeft = arrowRight - 8;

            ctx.strokeStyle = "#9ca3af";
            ctx.lineWidth = 1;

            // Shaft
            ctx.beginPath();
            ctx.moveTo(arrowLeft - 2, centerY);
            ctx.lineTo(arrowRight - 1, centerY);
            ctx.stroke();

            // Head
            ctx.beginPath();
            ctx.moveTo(arrowRight - 3.5, centerY - 3.5);
            ctx.lineTo(arrowRight, centerY);
            ctx.lineTo(arrowRight - 3.5, centerY + 3.5);
            ctx.stroke();
          }

          ctx.fillStyle = textColor;
          ctx.fillText(displayText, x + 8, y + ROW_HEIGHT / 2);
        }
      }
    }
  }, [
    bodyH,
    totalRows,
    viewport.w,
    columns,
    colLefts,
    colWidths,
    getRowAt,
    isCellDirty,
    deletedRows,
    isNewRow,
    selectedRows,
    selected,
    isFocused,
    foreignKeyMap,
  ]);

  useEffect(() => {
    textCacheRef.current.clear();
    cellTextCacheRef.current.clear();
  }, [dataVersion, colWidths]);

  // --------------------------------------------------------------------------
  // Resize Observer
  // --------------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    let rafId: number | null = null;
    let nextW = Math.max(1, Math.floor(el.clientWidth));
    let nextH = Math.max(1, Math.floor(el.clientHeight));

    const commitViewport = () => {
      rafId = null;
      const prev = viewportRef.current;
      if (prev.w === nextW && prev.h === nextH) return;
      const next = { w: nextW, h: nextH };
      viewportRef.current = next;
      setViewport(next);
    };

    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      nextW = Math.max(1, Math.floor(rect.width));
      nextH = Math.max(1, Math.floor(rect.height));
      if (rafId != null) return;
      rafId = requestAnimationFrame(commitViewport);
    });

    commitViewport();
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  // --------------------------------------------------------------------------
  // Canvas Resolution Setup (HiDPI support)
  // --------------------------------------------------------------------------
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${viewport.w}px`;
    canvas.style.height = `${bodyH}px`;
    canvas.width = Math.floor(viewport.w * dpr);
    canvas.height = Math.floor(bodyH * dpr);

    const ctx = canvas.getContext("2d");
    ctxRef.current = ctx;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    draw();
  }, [viewport.w, viewport.h, bodyH, draw]);

  // --------------------------------------------------------------------------
  // Helper: Get Cell Rect
  // --------------------------------------------------------------------------
  const getRect = useCallback(
    (
      rowIdx: number,
      colIdx: number,
      currentLeft: number,
      currentTop: number
    ) => {
      const col = columns[colIdx];
      if (!col) return null;

      const x = (colLefts[colIdx] ?? 0) - currentLeft;
      const w = colWidths[col.name] ?? 140; // Use state
      const y = rowIdx * ROW_HEIGHT - currentTop;
      const h = ROW_HEIGHT;

      return { x, y, w, h };
    },
    [columns, colLefts, colWidths]
  );

  useEffect(() => {
    draw();
  }, [draw, dataVersion]);

  // --------------------------------------------------------------------------
  // Scroll Handler
  // --------------------------------------------------------------------------
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const isLowerBound =
        el.scrollTop > ROW_HEIGHT &&
        el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

      scrollRef.current.left = el.scrollLeft;
      scrollRef.current.top = isLowerBound
        ? el.scrollTop - HEADER_HEIGHT + 2
        : el.scrollTop + 2;

      if (headerRef.current) {
        headerRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
      }

      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          draw();
          rafRef.current = null;
        });
      }
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [draw]);

  // --------------------------------------------------------------------------
  // Resize Handlers (Logic)
  // --------------------------------------------------------------------------
  const handleResizeStart = (
    e: MouseEvent,
    colName: string,
    currentWidth: number
  ) => {
    e.preventDefault();
    e.stopPropagation();

    resizingRef.current = {
      colName,
      startX: e.clientX,
      startWidth: currentWidth,
    };
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;

    const onMove = (e: MouseEvent) => {
      const state = resizingRef.current;
      if (!state) return;

      const delta = e.clientX - state.startX;
      const newW = Math.max(50, state.startWidth + delta);

      // Update internal state -> Triggers re-render -> Updates colWidths -> Updates Draw
      setColWidths((prev) => ({
        ...prev,
        [state.colName]: newW,
      }));
    };

    const onUp = () => {
      setIsResizing(false);
      resizingRef.current = null;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizing]);

  const cancelExit = useCallback(() => {
    onExitEdit?.();
    setEditorRect(null);
    setEditorError(null);
  }, [onExitEdit]);

  const commitAndExit = useCallback(() => {
    if (!editing) return;
    if (editorKind === "blob") {
      cancelExit();
      return;
    }

    let nextValue: unknown = editorValue;
    if (editorKind === "json" && editorValue.trim() !== "") {
      try {
        nextValue = JSON.stringify(JSON.parse(editorValue));
      } catch {
        setEditorError("Invalid JSON");
        return;
      }
    } else if (editorKind === "bool") {
      nextValue = editorValue === "__NULL__" ? null : editorValue === "true";
    } else if (editorKind === "date" || editorKind === "datetime") {
      nextValue = fromDateInputValue(editorValue, editorKind);
    }

    onCommitEdit?.(editing, nextValue);
    onExitEdit?.();
    setEditorRect(null);
    setEditorError(null);
  }, [editing, editorKind, editorValue, onCommitEdit, onExitEdit, cancelExit]);

  const commitNullAndExit = useCallback(() => {
    if (!editing || editorKind === "blob") return;
    onCommitEdit?.(editing, null);
    onExitEdit?.();
    setEditorRect(null);
    setEditorError(null);
  }, [editing, editorKind, onCommitEdit, onExitEdit]);

  // --------------------------------------------------------------------------
  // Auto-scroll on new row
  // --------------------------------------------------------------------------
  const prevTotalRows = useRef(totalRows);
  useEffect(() => {
    if (totalRows === prevTotalRows.current + 1) {
      let newlyAddedVisibleIdx = -1;
      for (let r = totalRows - 1; r >= 0; r--) {
        if (isNewRow?.(r)) {
          newlyAddedVisibleIdx = r;
          break;
        }
      }

      if (newlyAddedVisibleIdx >= 0) {
        const el = scrollerRef.current;
        if (el) {
          const yRowTop = newlyAddedVisibleIdx * ROW_HEIGHT;
          const toSeeTop = yRowTop;
          const toSeeBottom =
            yRowTop + ROW_HEIGHT + HEADER_HEIGHT - el.clientHeight;

          if (el.scrollTop > toSeeTop - ROW_HEIGHT) {
            el.scrollTop = Math.max(0, toSeeTop - ROW_HEIGHT * 2);
          } else if (el.scrollTop < toSeeBottom + ROW_HEIGHT) {
            el.scrollTop = toSeeBottom + ROW_HEIGHT * 2;
          }
        }

        onSelect?.(newlyAddedVisibleIdx, 0);
      }
    }
    prevTotalRows.current = totalRows;
  }, [totalRows, isNewRow, onSelect]);

  // --------------------------------------------------------------------------
  // Header click: sort toggling
  // --------------------------------------------------------------------------
  const handleHeaderClick = useCallback(
    (colName: string) => {
      if (!onChangeSort) return;

      const currentDir =
        sortState && sortState.colName === colName ? sortState.direction : null;

      let next: { colName: string; direction: "asc" | "desc" } | null;
      if (currentDir === "desc") {
        next = { colName, direction: "asc" };
      } else if (currentDir === "asc") {
        next = null; // clear sort
      } else {
        next = { colName, direction: "desc" };
      }

      onChangeSort(next);
    },
    [onChangeSort, sortState]
  );

  const headerMenuItems = useMemo<MenuItem[]>(() => {
    const colName = headerMenu?.colName;
    const hasSort = !!sortState;
    return [
      {
        type: "item",
        label: "Copy name",
        disabled: !colName,
        onClick: () => {
          if (!colName) return;
          void navigator.clipboard.writeText(colName);
        },
      },
      { type: "sep" },
      {
        type: "item",
        label: "Sort ascending",
        disabled: !onChangeSort || !colName,
        onClick: () => {
          if (!onChangeSort || !colName) return;
          onChangeSort({ colName, direction: "asc" });
        },
      },
      {
        type: "item",
        label: "Sort descending",
        disabled: !onChangeSort || !colName,
        onClick: () => {
          if (!onChangeSort || !colName) return;
          onChangeSort({ colName, direction: "desc" });
        },
      },
      { type: "sep" },
      {
        type: "item",
        label: "Remove sort",
        disabled: !onChangeSort || !hasSort,
        onClick: () => {
          if (!onChangeSort) return;
          onChangeSort(null);
        },
      },
    ];
  }, [headerMenu?.colName, onChangeSort, sortState]);

  const copyCellValue = useCallback(
    (rowIdx: number, colIdx: number) => {
      const row = getRowAt(rowIdx);
      void navigator.clipboard.writeText(formatCellForClipboard(row?.[colIdx]));
    },
    [getRowAt]
  );

  const copyRowsAs = useCallback(
    (
      rowIndices: number[],
      format:
        | "plain"
        | "json"
        | "html"
        | "markdown"
        | "csv"
        | "csv-header"
        | "insert"
    ) => {
      const rows = rowIndices
        .filter((rowIdx) => rowIdx >= 0 && rowIdx < totalRows)
        .map((rowIdx) => getRowAt(rowIdx))
        .filter((row): row is unknown[] => Array.isArray(row));
      if (!rows.length) return;
      const text = formatRowsForClipboard({
        format,
        columns,
        rows,
        schema,
        tableName,
        engine,
      });
      void navigator.clipboard.writeText(text);
    },
    [columns, engine, getRowAt, schema, tableName, totalRows]
  );

  const getSelectedRowIndices = useCallback(() => {
    if (selectedRows && selectedRows.size > 0) {
      return Array.from(selectedRows)
        .filter((rowIdx) => rowIdx >= 0 && rowIdx < totalRows)
        .sort((a, b) => a - b);
    }
    if (selected && selected.rowIdx >= 0 && selected.rowIdx < totalRows) {
      return [selected.rowIdx];
    }
    return [];
  }, [selected, selectedRows, totalRows]);

  const copySelectedRowsToClipboard = useCallback(() => {
    const rowIndices = getSelectedRowIndices();
    if (!rowIndices.length) return false;
    const rows = rowIndices
      .map((rowIdx) => getRowAt(rowIdx))
      .filter((row): row is unknown[] => Array.isArray(row));
    if (!rows.length) return false;
    void navigator.clipboard.writeText(
      serializeRowsForInternalClipboard(columns, rows)
    );
    return true;
  }, [columns, getRowAt, getSelectedRowIndices]);

  const pasteRowsFromClipboard = useCallback(() => {
    if (!onPasteRows) return false;
    void navigator.clipboard.readText().then((text) => {
      const parsed = parseRowsFromInternalClipboard(text);
      if (!parsed) return;
      onPasteRows(parsed.rows, parsed.columns);
    });
    return true;
  }, [onPasteRows]);

  const commitMenuValue = useCallback(
    (rowIdx: number, colIdx: number, value: unknown) => {
      if (rowIdx < 0 || colIdx < 0) return;
      onCommitEdit?.({ rowIdx, colIdx }, value);
    },
    [onCommitEdit]
  );

  const addFileValue = useCallback(
    async (rowIdx: number, colIdx: number) => {
      const path = await openDialog({
        title: "Set cell value from file",
        multiple: false,
        directory: false,
      });
      if (!path || typeof path !== "string") return;
      const bytes = await readFile(path);
      commitMenuValue(rowIdx, colIdx, bytes);
    },
    [commitMenuValue]
  );

  const rowMenuItems = useMemo<MenuItem[]>(() => {
    const rowIdx = rowMenu?.rowIdx ?? -1;
    const colIdx = rowMenu?.colIdx ?? -1;
    const col = columns[colIdx];
    const colType = col?.db_type ?? "";
    const isBlob = isBlobColumnType(colType);
    const hasDefault = col?.column_default != null && col.column_default !== "";
    const rowIsInSelection = rowIdx >= 0 && !!selectedRows?.has(rowIdx);
    const selectedRowIndices =
      rowIsInSelection && selectedRows && selectedRows.size > 0
        ? Array.from(selectedRows).sort((a, b) => a - b)
        : rowIdx >= 0
          ? [rowIdx]
          : [];
    const deleteLabel =
      selectedRowIndices.length > 1
        ? `Delete ${selectedRowIndices.length} rows`
        : "Delete";

    return [
      {
        type: "item",
        label: "Refresh",
        disabled: !onRefresh,
        onClick: () => onRefresh?.(),
      },
      { type: "sep" },
      {
        type: "item",
        label: "Add Row",
        disabled: !onAddRow,
        onClick: () => onAddRow?.(),
      },
      {
        type: "item",
        label: "Duplicate",
        disabled: !onDuplicateRow || rowIdx < 0,
        onClick: () => onDuplicateRow?.(rowIdx),
      },
      {
        type: "item",
        label: "Set Value",
        disabled: rowIdx < 0 || colIdx < 0,
        submenu: [
          {
            type: "item",
            label: "EMPTY",
            disabled: rowIdx < 0 || colIdx < 0 || !onCommitEdit || isBlob,
            onClick: () => commitMenuValue(rowIdx, colIdx, ""),
          },
          {
            type: "item",
            label: "NULL",
            disabled: rowIdx < 0 || colIdx < 0 || !onCommitEdit,
            onClick: () => commitMenuValue(rowIdx, colIdx, null),
          },
          {
            type: "item",
            label: "DEFAULT",
            disabled: rowIdx < 0 || colIdx < 0 || !onCommitEdit || !hasDefault,
            onClick: () =>
              commitMenuValue(rowIdx, colIdx, defaultCellEditValue()),
          },
          { type: "sep" },
          {
            type: "item",
            label: "Add a file...",
            disabled: rowIdx < 0 || colIdx < 0 || !onCommitEdit || !isBlob,
            onClick: () => {
              void addFileValue(rowIdx, colIdx);
            },
          },
        ],
      },
      { type: "sep" },
      {
        type: "item",
        label: "Copy Cell Value",
        disabled: rowIdx < 0 || colIdx < 0,
        onClick: () => copyCellValue(rowIdx, colIdx),
      },
      {
        type: "item",
        label: "Copy Rows As",
        disabled: selectedRowIndices.length === 0,
        submenu: [
          {
            type: "item",
            label: "Plain Text",
            onClick: () => copyRowsAs(selectedRowIndices, "plain"),
          },
          { type: "sep" },
          {
            type: "item",
            label: "JSON",
            onClick: () => copyRowsAs(selectedRowIndices, "json"),
          },
          {
            type: "item",
            label: "HTML",
            onClick: () => copyRowsAs(selectedRowIndices, "html"),
          },
          { type: "sep" },
          {
            type: "item",
            label: "Markdown Table",
            onClick: () => copyRowsAs(selectedRowIndices, "markdown"),
          },
          { type: "sep" },
          {
            type: "item",
            label: "CSV",
            onClick: () => copyRowsAs(selectedRowIndices, "csv"),
          },
          {
            type: "item",
            label: "CSV with Header",
            onClick: () => copyRowsAs(selectedRowIndices, "csv-header"),
          },
          { type: "sep" },
          {
            type: "item",
            label: "INSERT Statement",
            onClick: () => copyRowsAs(selectedRowIndices, "insert"),
          },
        ],
      },
      { type: "sep" },
      {
        type: "item",
        label: "Quick Filter",
        disabled: !onQuickFilter || !col,
        onClick: () => {
          if (!col || !rowMenu) return;
          onQuickFilter?.(col.name, rowMenu.value);
        },
      },
      {
        type: "item",
        label: "Export current page...",
        disabled: !onExportCurrentPage,
        onClick: () => onExportCurrentPage?.(),
      },
      {
        type: "item",
        label: "Import data...",
        disabled: !onImportData,
        onClick: () => onImportData?.(),
      },
      { type: "sep" },
      {
        type: "item",
        label: deleteLabel,
        color: "red",
        disabled:
          selectedRowIndices.length === 0 || (!onDeleteRows && !onDeleteRow),
        onClick: () => {
          if (onDeleteRows) onDeleteRows(selectedRowIndices);
          else if (rowIdx >= 0) onDeleteRow?.(rowIdx);
        },
      },
    ];
  }, [
    columns,
    rowMenu,
    selectedRows,
    onRefresh,
    onAddRow,
    onDuplicateRow,
    onCommitEdit,
    onDeleteRow,
    onDeleteRows,
    onExportCurrentPage,
    onImportData,
    onQuickFilter,
    copyCellValue,
    copyRowsAs,
    commitMenuValue,
    addFileValue,
  ]);

  // --------------------------------------------------------------------------
  // Mouse Handlers (Select / Edit)
  // --------------------------------------------------------------------------
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      const host = scrollerRef.current;
      if (!host) return;

      const rect = host.getBoundingClientRect();
      const x0 = e.clientX - rect.left;
      const y0 = e.clientY - rect.top;

      if (y0 < HEADER_HEIGHT) {
        if (editing) commitAndExit();
        onClearSelection?.();
        return;
      }

      const { left, top } = scrollRef.current;
      const x = x0 + left;
      const y = y0 - HEADER_HEIGHT + top;

      const rowIdx = Math.floor(y / ROW_HEIGHT);
      if (rowIdx < 0 || rowIdx >= totalRows) {
        if (editing) commitAndExit();
        onClearSelection?.();
        return;
      }

      const colIdx = hitTestCol(x, columns, colLefts, colWidths);
      if (colIdx < 0) {
        if (editing) commitAndExit();
        onClearSelection?.();
        return;
      }

      // If this is an FK column and click is on the arrow area (right ~16px),
      // trigger navigation instead of normal select.
      if (foreignKeyMap && onCellActivate) {
        const col = columns[colIdx];
        const fk = foreignKeyMap[col.name];
        if (fk) {
          const colLeft = colLefts[colIdx] ?? 0;
          const w = colWidths[col.name] ?? 140;
          const relX = x - colLeft;
          if (relX >= w - 18 && relX <= w) {
            const handled = onCellActivate({ rowIdx, colIdx });
            if (handled) return;
          }
        }
      }

      // Commit any existing edit before selecting new cell
      if (editing) {
        commitAndExit();
      }

      rootRef.current?.focus();
      onSelect?.(rowIdx, colIdx, e.metaKey || e.ctrlKey, e.shiftKey);
    },
    [
      totalRows,
      columns,
      colLefts,
      colWidths,
      foreignKeyMap,
      onCellActivate,
      editing,
      rootRef,
      onSelect,
      commitAndExit,
      onClearSelection,
    ]
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      const host = scrollerRef.current;
      if (!host) return;

      const rect = host.getBoundingClientRect();
      const x0 = e.clientX - rect.left;
      const y0 = e.clientY - rect.top;
      if (y0 < HEADER_HEIGHT) return;

      e.preventDefault();
      e.stopPropagation();

      const { left, top } = scrollRef.current;
      const x = x0 + left;
      const y = y0 - HEADER_HEIGHT + top;
      const rowIdx = Math.floor(y / ROW_HEIGHT);
      const colIdx = hitTestCol(x, columns, colLefts, colWidths);

      if (rowIdx < 0 || rowIdx >= totalRows || colIdx < 0) {
        setHeaderMenu(null);
        setRowMenu({
          x: e.clientX,
          y: e.clientY,
          rowIdx: -1,
          colIdx: -1,
          value: "",
        });
        return;
      }

      if (!selectedRows?.has(rowIdx)) {
        onSelect?.(rowIdx, colIdx);
      }

      const row = getRowAt(rowIdx);
      const value = formatCellForClipboard(row?.[colIdx]);
      setHeaderMenu(null);
      setRowMenu({
        x: e.clientX,
        y: e.clientY,
        rowIdx,
        colIdx,
        value,
      });
    },
    [columns, colLefts, colWidths, totalRows, selectedRows, getRowAt, onSelect]
  );

  const handleDblClick = useCallback(
    (e: MouseEvent) => {
      const host = scrollerRef.current;
      if (!host) return;

      const rect = host.getBoundingClientRect();
      const x0 = e.clientX - rect.left;
      const y0 = e.clientY - rect.top;

      if (y0 < HEADER_HEIGHT) return;

      const { left, top } = scrollRef.current;
      const x = x0 + left;
      const y = y0 - HEADER_HEIGHT + top;

      const rowIdx = Math.floor(y / ROW_HEIGHT);

      if (rowIdx >= totalRows) {
        onAddRow?.();
        return;
      }
      if (rowIdx < 0) return;

      const colIdx = hitTestCol(x, columns, colLefts, colWidths);
      if (colIdx < 0) return;

      onStartEdit?.({ rowIdx, colIdx });

      const row = getRowAt(rowIdx);
      const kind = getCellEditorKind(columns[colIdx]);
      const s = formatTableCellValue(
        row?.[colIdx] ?? null,
        columns[colIdx]?.db_type
      );
      setEditorError(null);
      if (kind === "bool") {
        const normalized = String(s ?? "").toLowerCase();
        setEditorValue(
          normalized === "true" || normalized === "1"
            ? "true"
            : normalized === "false" || normalized === "0"
              ? "false"
              : "__NULL__"
        );
      } else if (kind === "date" || kind === "datetime") {
        setEditorValue(toDateInputValue(s ?? "", kind));
      } else {
        setEditorValue(s ?? "");
      }

      const r2 = getRect(rowIdx, colIdx, left, top);
      if (r2) setEditorRect(r2);

      queueMicrotask(() => editorRef.current?.focus());
    },
    [
      columns,
      colLefts,
      colWidths,
      totalRows,
      onAddRow,
      onStartEdit,
      getRowAt,
      getRect,
    ]
  );

  // Sync editor position when widths change or scrolling
  useEffect(() => {
    if (!editing) return;
    const { left, top } = scrollRef.current;
    const r = getRect(editing.rowIdx, editing.colIdx, left, top);
    if (r) setEditorRect(r);
  }, [editing, getRect, colWidths]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div
      ref={rootCallbackRef}
      class={`table-focus-root relative h-full min-h-0 w-full bg-white outline-none ${
        isResizing ? "cursor-col-resize select-none" : ""
      }`}
      tabIndex={0}
      onKeyDown={(e) => {
        // When editing a cell, let the input handle Backspace/Delete
        // instead of triggering row delete at the table level.
        if (editing) return;

        if ((e.metaKey || e.ctrlKey) && e.key === "a") {
          e.preventDefault();
          onSelectAllRows?.();
          return;
        }

        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
          if (copySelectedRowsToClipboard()) {
            e.preventDefault();
          }
          return;
        }

        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
          if (pasteRowsFromClipboard()) {
            e.preventDefault();
          }
          return;
        }

        const hasSelection =
          (selectedRows && selectedRows.size > 0) || selected;
        if (!hasSelection) return;

        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();

          if (onDeleteRows && selectedRows && selectedRows.size > 0) {
            onDeleteRows(Array.from(selectedRows));
          } else if (selected) {
            if (onDeleteRows) {
              onDeleteRows([selected.rowIdx]);
            } else {
              onDeleteRow?.(selected.rowIdx);
            }
          }
        }
      }}
    >
      <div
        ref={scrollerRef}
        class="relative h-full min-h-0 w-full overflow-auto overscroll-none border-t border-neutral-200"
        style={{ overscrollBehavior: "none" }}
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
        onDblClick={handleDblClick}
      >
        {/* Sticky Header Container */}
        <div
          class="sticky top-0 left-0 z-10 overflow-hidden border-b border-neutral-200 bg-neutral-50"
          style={{ width: viewport.w }}
        >
          {/* Inner Header */}
          <div
            ref={headerRef}
            class="flex"
            style={{
              height: HEADER_HEIGHT,
              width: Math.max(1, totalWidth),
              willChange: "transform",
            }}
          >
            {columns.map((col) => {
              // Render using internal state
              const w = colWidths[col.name] ?? 140;
              const isSorted = sortState?.colName === col.name;
              const sortDir = isSorted ? sortState!.direction : null;
              return (
                <div
                  key={col.name}
                  class={cn(
                    "relative box-border flex items-center justify-between gap-1 border-r border-neutral-200",
                    "px-2 text-sm font-semibold whitespace-nowrap text-neutral-700",
                    onChangeSort && "select-none active:bg-neutral-100"
                  )}
                  style={{ width: w, height: HEADER_HEIGHT }}
                  onMouseUp={(e) => {
                    if (!onChangeSort) return;
                    if (e.button !== 0) return;
                    if (
                      (e.target as HTMLElement).closest("[data-resize-handle]")
                    )
                      return;
                    e.stopPropagation();
                    handleHeaderClick(col.name);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setHeaderMenu({
                      x: e.clientX,
                      y: e.clientY,
                      colName: col.name,
                    });
                  }}
                >
                  <span class="truncate">{col.name}</span>

                  {isSorted &&
                    (sortDir === "asc" ? (
                      <ChevronUpIcon className="size-3 shrink-0" />
                    ) : (
                      <ChevronDownIcon className="size-3 shrink-0" />
                    ))}

                  {/* --- RESIZE HANDLE --- */}
                  <div
                    data-resize-handle
                    class="absolute top-0 right-0 z-10 h-full w-0.5 cursor-col-resize hover:bg-neutral-200 active:bg-neutral-400"
                    onMouseDown={(e) => handleResizeStart(e, col.name, w)}
                  />
                </div>
              );
            })}
            {emptyColumnWidth > 0 && (
              <div
                class="box-border border-r border-neutral-200"
                style={{ width: emptyColumnWidth, height: HEADER_HEIGHT }}
              />
            )}
          </div>
        </div>

        {/* Content Height Spacer */}
        <div
          style={{
            width: Math.max(1, totalWidth),
            height: Math.max(1, HEADER_HEIGHT + totalRows * ROW_HEIGHT),
            position: "relative",
          }}
        >
          {/* Canvas Layer */}
          <canvas
            ref={canvasRef}
            style={{
              position: "sticky",
              top: HEADER_HEIGHT,
              left: 0,
              display: "block",
              zIndex: 1,
            }}
          />
        </div>
      </div>

      {/* Editor Overlay */}
      {editorRect && editing && !isResizing && (
        <div
          class="absolute z-60"
          style={{
            left: editorRect.x + 2,
            top: editorRect.y + HEADER_HEIGHT + 4,
            width: Math.max(
              editorRect.w - 4,
              editorKind === "json" ? 260 : 116
            ),
          }}
        >
          {editorKind === "json" ? (
            <textarea
              ref={editorRef as any}
              class={cn(
                "min-h-24 w-full resize bg-white px-2 py-1 font-mono text-xs shadow-sm outline-none",
                "ring-2 ring-blue-500",
                editorError && "ring-red-500"
              )}
              value={editorValue}
              onInput={(e) =>
                setEditorValue((e.currentTarget as HTMLTextAreaElement).value)
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  commitAndExit();
                }
                if (e.key === "Escape") cancelExit();
              }}
              onBlur={commitAndExit}
            />
          ) : editorKind === "bool" ? (
            <select
              ref={editorRef as any}
              class="h-7 w-full bg-white px-2 text-sm shadow-sm outline-none"
              value={editorValue}
              onInput={(e) =>
                setEditorValue((e.currentTarget as HTMLSelectElement).value)
              }
              onChange={(e) =>
                setEditorValue((e.currentTarget as HTMLSelectElement).value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAndExit();
                if (e.key === "Escape") cancelExit();
              }}
              onBlur={commitAndExit}
            >
              <option value="true">true</option>
              <option value="false">false</option>
              <option value="__NULL__">NULL</option>
            </select>
          ) : (
            <input
              ref={editorRef as any}
              class={cn(
                "h-7 w-full bg-white px-2 text-sm shadow-sm outline-none disabled:text-neutral-500",
                "ring-2 ring-blue-500"
              )}
              type={editorKind === "date" ? "date" : "text"}
              placeholder={
                editorKind === "blob"
                  ? "Binary value is read-only"
                  : editorKind === "datetime"
                    ? "YYYY-MM-DD HH:mm:ss+07"
                    : "NULL"
              }
              disabled={editorKind === "blob"}
              value={
                editorKind === "blob"
                  ? "Binary value is read-only"
                  : editorValue
              }
              onInput={(e) =>
                setEditorValue((e.currentTarget as HTMLInputElement).value)
              }
              onChange={(e) =>
                setEditorValue((e.currentTarget as HTMLInputElement).value)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAndExit();
                if (e.key === "Escape") cancelExit();
              }}
              onBlur={editorKind === "blob" ? cancelExit : commitAndExit}
            />
          )}
          {editorError && (
            <p class="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700 shadow">
              {editorError}
            </p>
          )}
          {editorKind !== "blob" && (
            <button
              type="button"
              class="mt-1 rounded border border-neutral-200 bg-white px-2 py-0.5 text-xs text-neutral-600 shadow-sm hover:bg-neutral-50"
              onMouseDown={(e) => e.preventDefault()}
              onClick={commitNullAndExit}
            >
              Set NULL
            </button>
          )}
        </div>
      )}

      <ContextMenu
        open={headerMenu !== null}
        x={headerMenu?.x ?? 0}
        y={headerMenu?.y ?? 0}
        items={headerMenuItems}
        onClose={() => setHeaderMenu(null)}
      />
      <ContextMenu
        open={rowMenu !== null}
        x={rowMenu?.x ?? 0}
        y={rowMenu?.y ?? 0}
        items={rowMenuItems}
        onClose={() => setRowMenu(null)}
      />
    </div>
  );
}
