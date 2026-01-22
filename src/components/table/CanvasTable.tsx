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

  widthByName: Record<string, number>;
  emptyColumnWidth: number;

  selected?: { rowIdx: number; colIdx: number } | null;
  editing?: EditingCell | null;

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
  // linear scan is fine for ~30 columns
  for (let i = 0; i < cols.length; i++) {
    const w = widthByName[cols[i]!.name] ?? 140;
    const l = lefts[i]!;
    if (x >= l && x < l + w) return i;
  }
  return -1;
}

export function CanvasTable({
  columns,
  totalRows,
  getRowAt,
  widthByName,
  emptyColumnWidth,
  selected,
  editing,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onExitEdit,
  onAddRow,
  onDeleteRow,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // editor overlay
  const editorRef = useRef<HTMLInputElement>(null);
  const [editorValue, setEditorValue] = useState("");
  const [editorRect, setEditorRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  const [viewport, setViewport] = useState({ w: 1, h: 1 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });

  const totalWidth = useMemo(
    () => sumWidths(columns, widthByName, emptyColumnWidth),
    [columns, widthByName, emptyColumnWidth]
  );

  const colLefts = useMemo(
    () => buildColLefts(columns, widthByName),
    [columns, widthByName]
  );

  // --------------------------------------------------------------------------
  // Resize observer (viewport)
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
  // Scroll
  // --------------------------------------------------------------------------

  const onScroll = useCallback((e: Event) => {
    const el = e.currentTarget as HTMLDivElement;
    setScroll({ top: el.scrollTop, left: el.scrollLeft });
  }, []);

  // --------------------------------------------------------------------------
  // Canvas backing store (HiDPI)
  // --------------------------------------------------------------------------

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${viewport.w}px`;
    canvas.style.height = `${viewport.h}px`;
    canvas.width = Math.floor(viewport.w * dpr);
    canvas.height = Math.floor(viewport.h * dpr);

    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [viewport.w, viewport.h]);

  // --------------------------------------------------------------------------
  // Visible rows
  // --------------------------------------------------------------------------

  const visible = useMemo(() => {
    const firstRow = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT));
    const visibleCount = Math.ceil(viewport.h / ROW_HEIGHT) + 4; // small overscan
    const lastRow = Math.min(totalRows, firstRow + visibleCount);
    return { firstRow, lastRow };
  }, [scroll.top, viewport.h, totalRows]);

  // --------------------------------------------------------------------------
  // Cell rect (for editor overlay)
  // --------------------------------------------------------------------------

  const getCellRect = useCallback(
    (rowIdx: number, colIdx: number) => {
      const col = columns[colIdx];
      if (!col) return null;

      const x = (colLefts[colIdx] ?? 0) - scroll.left;
      const w = widthByName[col.name] ?? 140;

      const y = rowIdx * ROW_HEIGHT - scroll.top;
      const h = ROW_HEIGHT;

      return { x, y, w, h };
    },
    [columns, colLefts, scroll.left, scroll.top, widthByName]
  );

  // --------------------------------------------------------------------------
  // Draw canvas (BODY ONLY)
  // --------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    ctx.clearRect(0, 0, viewport.w, viewport.h);

    // Background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, viewport.w, viewport.h);

    // Zebra background
    for (let r = visible.firstRow; r < visible.lastRow; r++) {
      if ((r & 1) === 1) {
        const y = r * ROW_HEIGHT - scroll.top;
        ctx.fillStyle = "#fafafa";
        ctx.fillRect(0, y, viewport.w, ROW_HEIGHT);
      }
    }

    // Horizontal grid lines
    ctx.strokeStyle = "#f3f4f6";
    ctx.beginPath();
    const startY = -(scroll.top % ROW_HEIGHT || 0);
    for (let y = startY; y <= viewport.h; y += ROW_HEIGHT) {
      const yy = Math.floor(y) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(viewport.w, yy);
    }
    ctx.stroke();

    // Vertical grid lines
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();

    // Left border
    ctx.moveTo(0.5, 0);
    ctx.lineTo(0.5, viewport.h);

    for (let c = 0; c < columns.length; c++) {
      const col = columns[c]!;
      const x = (colLefts[c] ?? 0) - scroll.left;
      const w = widthByName[col.name] ?? 140;
      const xr = x + w;

      if (xr < 0 || xr > viewport.w) continue;

      const xx = Math.floor(xr) + 0.5;
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, viewport.h);
    }

    // Right border
    ctx.moveTo(viewport.w - 0.5, 0);
    ctx.lineTo(viewport.w - 0.5, viewport.h);

    ctx.stroke();

    // Text
    ctx.font = "400 13px system-ui, -apple-system, Segoe UI, sans-serif";
    ctx.textBaseline = "middle";

    for (let r = visible.firstRow; r < visible.lastRow; r++) {
      const y = r * ROW_HEIGHT - scroll.top;

      const row = getRowAt(r);
      if (!row) continue;

      // Selected cell background
      if (selected && selected.rowIdx === r) {
        const rect = getCellRect(r, selected.colIdx);
        if (rect) {
          ctx.fillStyle = "#dbeafe";
          ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        }
      }

      for (let c = 0; c < columns.length; c++) {
        const col = columns[c]!;
        const x = (colLefts[c] ?? 0) - scroll.left;
        const w = widthByName[col.name] ?? 140;
        if (x + w < 0 || x > viewport.w) continue;

        const v = row[c] ?? null;
        const s = cellToString(v);

        ctx.fillStyle = s ? "#111827" : "#9ca3af";
        drawTruncatedText(ctx, s || "NULL", x + 8, y + ROW_HEIGHT / 2, w - 16);
      }
    }
  }, [
    viewport.w,
    viewport.h,
    scroll.top,
    scroll.left,
    visible.firstRow,
    visible.lastRow,
    columns,
    colLefts,
    widthByName,
    getRowAt,
    selected,
    getCellRect,
  ]);

  // --------------------------------------------------------------------------
  // Mouse interaction
  // --------------------------------------------------------------------------

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      const host = scrollerRef.current;
      if (!host) return;

      const rect = host.getBoundingClientRect();
      const x = e.clientX - rect.left + scroll.left;
      const y = e.clientY - rect.top + scroll.top;

      const rowIdx = Math.floor(y / ROW_HEIGHT);
      if (rowIdx < 0 || rowIdx >= totalRows) return;

      const colIdx = hitTestCol(x, columns, colLefts, widthByName);
      if (colIdx < 0) return;

      onSelect?.(rowIdx, colIdx);
    },
    [
      scroll.left,
      scroll.top,
      columns,
      colLefts,
      widthByName,
      totalRows,
      onSelect,
    ]
  );

  const handleDblClick = useCallback(
    (e: MouseEvent) => {
      const host = scrollerRef.current;
      if (!host) return;

      const rect = host.getBoundingClientRect();
      const x = e.clientX - rect.left + scroll.left;
      const y = e.clientY - rect.top + scroll.top;

      const rowIdx = Math.floor(y / ROW_HEIGHT);

      // dblclick below data => add row
      if (rowIdx >= totalRows) {
        onAddRow?.();
        return;
      }

      if (rowIdx < 0 || rowIdx >= totalRows) return;

      const colIdx = hitTestCol(x, columns, colLefts, widthByName);
      if (colIdx < 0) return;

      onStartEdit?.({ rowIdx, colIdx });

      const row = getRowAt(rowIdx);
      const s = cellToString(row?.[colIdx] ?? null);
      setEditorValue(s);

      const r2 = getCellRect(rowIdx, colIdx);
      if (r2) setEditorRect(r2);

      queueMicrotask(() => editorRef.current?.focus());
    },
    [
      scroll.left,
      scroll.top,
      columns,
      colLefts,
      widthByName,
      totalRows,
      onAddRow,
      onStartEdit,
      getRowAt,
      getCellRect,
    ]
  );

  // Keep editor synced on scroll
  useEffect(() => {
    if (!editing) return;
    const r = getCellRect(editing.rowIdx, editing.colIdx);
    if (r) setEditorRect(r);
  }, [editing, getCellRect, scroll.left, scroll.top]);

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
  // Render
  // --------------------------------------------------------------------------

  return (
    <div
      ref={rootRef}
      class="relative h-full w-full bg-white"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!selected) return;

        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onDeleteRow?.(selected.rowIdx);
        }
      }}
    >
      {/* HEADER */}
      <div class="sticky top-0 z-50 border-b border-neutral-200 bg-neutral-50">
        <div
          class="flex"
          style={{
            height: HEADER_HEIGHT,
            width: Math.max(1, totalWidth),
            transform: `translateX(${-scroll.left}px)`,
            willChange: "transform",
            paddingLeft: 1, // tiny nudge
          }}
        >
          {columns.map((col) => {
            const w = widthByName[col.name] ?? 140;
            return (
              <div
                key={col.name}
                class="box-border flex items-center border-r border-neutral-200 px-2 text-xs font-semibold whitespace-nowrap text-neutral-700"
                style={{ width: w, height: HEADER_HEIGHT }}
              >
                <span class="truncate">{col.name}</span>
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

      {/* BODY */}
      <div
        ref={scrollerRef}
        class="relative h-[calc(100%-32px)] w-full overflow-auto"
        onScroll={onScroll as any}
        onMouseDown={handleMouseDown as any}
        onDblClick={handleDblClick as any}
      >
        <div
          style={{
            width: Math.max(1, totalWidth),
            height: Math.max(1, totalRows * ROW_HEIGHT),
            position: "relative",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              position: "sticky",
              top: 0,
              left: 0,
              display: "block",
              zIndex: 1,
            }}
          />
        </div>
      </div>

      {/* EDITOR OVERLAY */}
      {editorRect && editing && (
        <input
          ref={editorRef}
          class="absolute z-60 border border-blue-400 bg-white px-2 text-sm outline-none"
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

// ============================================================================
// Text truncation
// ============================================================================

function drawTruncatedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number
) {
  if (maxWidth <= 0) return;
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }
  const ell = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = text.slice(0, mid) + ell;
    if (ctx.measureText(s).width <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  ctx.fillText(text.slice(0, Math.max(0, lo - 1)) + ell, x, y);
}
