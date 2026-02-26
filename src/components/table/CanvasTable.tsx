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

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 32;

type EditingCell = { rowIdx: number; colIdx: number };

type Props = {
  columns: ColumnMeta[];
  totalRows: number;
  getRowAt: (rowIndex: number) => unknown[] | undefined;
  isCellDirty?: (rowIdx: number, colName: string) => boolean;
  isNewRow?: (rowIdx: number) => boolean;

  widthByName: Record<string, number>;
  emptyColumnWidth: number;

  selected?: { rowIdx: number; colIdx: number } | null;
  editing?: EditingCell | null;
  deletedRows?: Set<number>;

  dataVersion: number;

  onSelect?: (rowIdx: number, colIdx: number) => void;
  onStartEdit?: (cell: EditingCell) => void;
  onCommitEdit?: (cell: EditingCell, value: string) => void;
  onExitEdit?: () => void;

  onDeleteRow?: (rowIdx: number) => void;
  onAddRow?: () => void;
};

// ============================================================================
// Utils
// ============================================================================

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
  onSelect,
  onStartEdit,
  onCommitEdit,
  onExitEdit,
  onDeleteRow,
  onAddRow,
  isCellDirty,
  isNewRow,
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
    ctx.strokeStyle = "#f3f4f6";

    // Horizontal
    const startY = -(top % ROW_HEIGHT || 0);
    for (let y = startY; y <= bodyH; y += ROW_HEIGHT) {
      const yy = Math.floor(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(viewport.w, yy);
    }

    // Vertical
    ctx.strokeStyle = "#e5e7eb";
    ctx.moveTo(0.5, 0);
    ctx.lineTo(0.5, bodyH);

    for (let c = 0; c < columns.length; c++) {
      const col = columns[c]!;
      const x = (colLefts[c] ?? 0) - left;
      const w = colWidths[col.name] ?? 140; // Use state
      const xr = x + w;

      if (xr < 0 || x > viewport.w) continue;

      const xx = Math.floor(xr) + 0.5;
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

      for (let c = 0; c < columns.length; c++) {
        const col = columns[c]!;
        const x = (colLefts[c] ?? 0) - left;
        const w = colWidths[col.name] ?? 140; // Use state

        if (x + w < 0 || x > viewport.w) continue;

        const v = row[c] ?? null;
        const s = cellToString(v) || "NULL";

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
            ctx.strokeStyle = "#51a2ff";
            ctx.strokeRect(x + 1, y + 1, w - 1, ROW_HEIGHT - 1);
            ctx.restore();
          }
        }

        if (s) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 8, y, w - 16, ROW_HEIGHT);
          ctx.clip();

          ctx.fillStyle = s === "NULL" ? "#9ca3af" : "#111827";
          ctx.fillText(s, x + 8, y + ROW_HEIGHT / 2);

          ctx.restore();
        }
      }
    }
  }, [
    viewport.w,
    bodyH,
    totalRows,
    columns,
    colLefts,
    colWidths, // Dependent on width changes
    getRowAt,
    selected,
    getRect,
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
        if (!selected) return;
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onDeleteRow?.(selected.rowIdx);
        }
      }}
    >
      <div
        ref={scrollerRef}
        class="relative h-full w-full overflow-auto overscroll-none"
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
              paddingLeft: 1,
            }}
          >
            {columns.map((col) => {
              // Render using internal state
              const w = colWidths[col.name] ?? 140;
              return (
                <div
                  key={col.name}
                  class="relative box-border flex items-center border-r border-neutral-200 px-2 text-xs font-semibold whitespace-nowrap text-neutral-700"
                  style={{ width: w, height: HEADER_HEIGHT }}
                >
                  <span class="truncate select-none">{col.name}</span>

                  {/* --- RESIZE HANDLE --- */}
                  <div
                    class="absolute top-0 right-0 z-10 h-full w-1 cursor-col-resize hover:bg-neutral-200 active:bg-neutral-400"
                    style={{ right: 0, width: 2, cursor: "col-resize" }}
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
          class="absolute z-60 border border-blue-400 bg-white px-2 text-sm shadow-sm outline-none"
          placeholder="NULL"
          style={{
            left: editorRect.x,
            top: editorRect.y + HEADER_HEIGHT,
            width: editorRect.w,
            height: editorRect.h,
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
