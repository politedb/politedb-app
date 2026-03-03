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
import { ArrowDown, ArrowUp } from "src/components/icons";
import { cn } from "src/utils/cn";

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 28;

type EditingCell = { rowIdx: number; colIdx: number };

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
  editing?: EditingCell | null;
  deletedRows?: Set<number>;

  dataVersion: number;

  onSelect?: (rowIdx: number, colIdx: number) => void;
  onStartEdit?: (cell: EditingCell) => void;
  onCommitEdit?: (cell: EditingCell, value: string) => void;
  onExitEdit?: () => void;

  // Called when user clicks a column header to change sort.
  onChangeSort?: (
    sort: { colName: string; direction: "asc" | "desc" } | null
  ) => void;

  onDeleteRow?: (rowIdx: number) => void;
  onAddRow?: () => void;
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

// ============================================================================
// Main Component
// ============================================================================

export function CanvasTable({
  columns,
  totalRows,
  getRowAt,
  widthByName = {}, // Default empty if not provided
  emptyColumnWidth,
  selected,
  editing,
  deletedRows,
  dataVersion,
  sortState,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onExitEdit,
  onDeleteRow,
  onAddRow,
  isCellDirty,
  isNewRow,
  onChangeSort,
}: Props) {
  // --- Refs for DOM elements ---
  const rootRef = useRef<HTMLDivElement>(null);
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
  const editorRef = useRef<HTMLInputElement>(null);
  const [editorValue, setEditorValue] = useState("");
  const [editorRect, setEditorRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  // --- Viewport ---
  const [viewport, setViewport] = useState({ w: 1, h: 1 });

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

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setViewport({
          w: Math.max(1, Math.floor(e.contentRect.width)),
          h: Math.max(1, Math.floor(e.contentRect.height)),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
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
  }, [viewport.w, viewport.h, bodyH]);

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
          s = cellToString(v) || "NULL";
          if (cellTextCacheRef.current.size > 50000) {
            cellTextCacheRef.current.clear();
          }
          cellTextCacheRef.current.set(valueKey, { raw: v, text: s });
        }

        const dirty = isCellDirty?.(r, col.name);

        if (dirty) {
          ctx.fillStyle = "#FEF3C7"; // amber-100
          ctx.fillRect(x + 1, y + 1, w - 1, ROW_HEIGHT - 1);
        }

        if (deletedRows?.has(r)) {
          ctx.fillStyle = "#ffa2a2";
          ctx.fillRect(x + 1, y + 1, w - 1, ROW_HEIGHT - 1);
        }

        if (isNewRow?.(r)) {
          ctx.fillStyle = "#dcfce7";
          ctx.fillRect(x + 1, y + 1, w - 1, ROW_HEIGHT - 1);
        }

        if (selected && selected.rowIdx === r) {
          ctx.fillStyle = "#bedbff";
          ctx.fillRect(x + 1, y + 1, w - 1, ROW_HEIGHT - 1);

          if (selected.colIdx === c) {
            ctx.strokeStyle = "#0000ff";
            ctx.strokeRect(
              x + 1,
              c === visibleCols.start ? y + 2 : y + 1,
              w - 1,
              ROW_HEIGHT - 1
            );
          }
        }

        if (s) {
          const maxTextWidth = Math.max(0, w - 16);
          const cacheKey = `${maxTextWidth}|${s}`;
          let displayText = textCacheRef.current.get(cacheKey);
          if (!displayText) {
            displayText = ellipsize(ctx, s, maxTextWidth);
            if (textCacheRef.current.size > 10000) {
              textCacheRef.current.clear();
            }
            textCacheRef.current.set(cacheKey, displayText);
          }

          ctx.fillStyle = s === "NULL" ? "#9ca3af" : "#111827";
          ctx.fillText(displayText, x + 8, y + ROW_HEIGHT / 2);
        }
      }
    }
  }, [
    viewport.w,
    bodyH,
    totalRows,
    columns,
    colLefts,
    colWidths,
    getRowAt,
    selected,
    deletedRows,
    isCellDirty,
    isNewRow,
  ]);

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

  const commitAndExit = useCallback(() => {
    if (!editing) return;
    onCommitEdit?.(editing, editorValue);
    onExitEdit?.();
    setEditorRect(null);
  }, [editing, editorValue, onCommitEdit, onExitEdit]);

  const cancelExit = useCallback(() => {
    onExitEdit?.();
    setEditorRect(null);
  }, [onExitEdit]);

  // --------------------------------------------------------------------------
  // Header click: sort toggling
  // --------------------------------------------------------------------------
  const handleHeaderClick = useCallback(
    (colName: string) => {
      if (!onChangeSort) return;

      const currentDir =
        sortState && sortState.colName === colName ? sortState.direction : null;

      let next: { colName: string; direction: "asc" | "desc" } | null;
      if (currentDir === "asc") {
        next = { colName, direction: "desc" };
      } else if (currentDir === "desc") {
        next = null; // clear sort
      } else {
        next = { colName, direction: "asc" };
      }

      onChangeSort(next);
    },
    [onChangeSort, sortState]
  );

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

      if (y0 < HEADER_HEIGHT) return;

      const { left, top } = scrollRef.current;
      const x = x0 + left;
      const y = y0 - HEADER_HEIGHT + top;

      const rowIdx = Math.floor(y / ROW_HEIGHT);
      if (rowIdx < 0 || rowIdx >= totalRows) return;

      const colIdx = hitTestCol(x, columns, colLefts, colWidths);
      if (colIdx < 0) return;

      // Commit any existing edit before selecting new cell
      if (editing) {
        commitAndExit();
      }

      onSelect?.(rowIdx, colIdx);
    },
    [columns, editing, totalRows, colLefts, colWidths, onSelect, commitAndExit]
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
      const s = cellToString(row?.[colIdx] ?? null);
      setEditorValue(s ?? "");

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
      ref={rootRef}
      class={`relative h-full w-full bg-white ${
        isResizing ? "cursor-col-resize select-none" : ""
      }`}
      tabIndex={0}
      onKeyDown={(e) => {
        // When editing a cell, let the input handle Backspace/Delete
        // instead of triggering row delete at the table level.
        if (editing) return;
        if (!selected) return;
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onDeleteRow?.(selected.rowIdx);
        }
      }}
    >
      <div
        ref={scrollerRef}
        class="relative h-full w-full overflow-auto overscroll-none border-t border-neutral-200"
        style={{ overscrollBehavior: "none" }}
        onMouseDown={handleMouseDown}
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
                  onPointerDown={(e) => {
                    if (!onChangeSort) return;
                    if (
                      (e.target as HTMLElement).closest("[data-resize-handle]")
                    )
                      return;
                    e.stopPropagation();
                    handleHeaderClick(col.name);
                  }}
                >
                  <span class="truncate">{col.name}</span>

                  {isSorted &&
                    (sortDir === "asc" ? (
                      <ArrowUp className="size-3 shrink-0" />
                    ) : (
                      <ArrowDown className="size-3 shrink-0" />
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
        <input
          ref={editorRef}
          class="absolute z-60 bg-white px-2 text-sm shadow-sm outline-none"
          placeholder="NULL"
          style={{
            left: editorRect.x + 2,
            top: editorRect.y + HEADER_HEIGHT + (editing.colIdx === 0 ? 5 : 4),
            width: editorRect.w - 3,
            height: editorRect.h - 3,
          }}
          value={editorValue}
          onInput={(e) =>
            setEditorValue((e.currentTarget as HTMLInputElement).value)
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") commitAndExit();
            if (e.key === "Escape") cancelExit();
          }}
          onBlur={commitAndExit}
        />
      )}
    </div>
  );
}
