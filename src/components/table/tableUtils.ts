import type { ColumnMeta } from "src/lib/tauri/types";

// ============================================================================
// Types
// ============================================================================

export type EditingCell = {
  rowIdx: number;
  colName: string;
  colIdx: number;
};

export interface NewRowData {
  row: Record<string, { v: any; t: string }>;
  rowKey: string;
  isNew: true;
}

// ============================================================================
// Constants
// ============================================================================

export const EMPTY_ARRAY: string[] = [];
export const EMPTY_SET = new Set<number>();
export const EMPTY_OBJECT: Record<string, any> = {};

export const MIN_COL_WIDTH = 60;
export const MAX_COL_WIDTH = 420;
export const DEFAULT_COL_WIDTH = 80;
export const MAX_RESIZE_WIDTH = 800;

// Virtuoso tuning
export const VIRTUOSO_OVERSCAN = 30;
export const VIRTUOSO_VIEWPORT_INCREASE = { top: 100, bottom: 100 };

// Pre-computed type width map (static, no runtime cost)
const TYPE_WIDTH_MAP: ReadonlyArray<readonly [string, number]> = [
  ["uuid", 280],
  ["timestamp", 220],
  ["date", 200],
  ["time", 200],
  ["bool", 80],
  ["int2", 80],
  ["int4", 80],
  ["int8", 80],
  ["numeric", 160],
  ["decimal", 160],
  ["float", 150],
  ["double", 150],
  ["json", 360],
  ["text", 120],
  ["varchar", 120],
  ["char", 120],
  ["bytea", 280],
  ["inet", 200],
  ["cidr", 200],
  ["macaddr", 200],
] as const;

// ============================================================================
// Utilities
// ============================================================================

export const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

export const norm = (s: string) => (s || "").toLowerCase();

export const inferCellType = (value: unknown): string => {
  if (value == null) return "Null";
  const t = typeof value;
  if (t === "number") return "Number";
  if (t === "boolean") return "Boolean";
  return "String";
};

export const guessWidthByMeta = (col: ColumnMeta): number => {
  const name = norm((col as any).name ?? "");
  const t = norm((col as any).db_type ?? (col as any).data_type ?? "");

  // Name-based hints (most specific first)
  if (name === "id" || name.endsWith("_id")) {
    return t.includes("uuid") || name.includes("uuid") ? 280 : 140;
  }
  if (name.includes("uuid")) return 280;
  if (name.includes("email")) return 280;
  if (name.includes("url") || name.includes("link")) return 200;

  // Type-based hints
  for (let i = 0; i < TYPE_WIDTH_MAP.length; i++) {
    if (t.includes(TYPE_WIDTH_MAP[i][0])) return TYPE_WIDTH_MAP[i][1];
  }

  return 160;
};

// Batch DOM read for auto-fit
export const measureAutoWidthForColumn = (
  container: HTMLElement,
  colName: string
): number => {
  const escapedCol = CSS.escape(colName);
  let maxWidth = 0;

  // Single querySelectorAll call
  const elements = container.querySelectorAll(
    `th[data-col="${escapedCol}"], tbody td[data-col="${escapedCol}"]`
  );

  // Batch read - triggers single reflow
  for (let i = 0; i < elements.length; i++) {
    const w = (elements[i] as HTMLElement).getBoundingClientRect().width;
    if (w > maxWidth) maxWidth = w;
    if (maxWidth >= MAX_COL_WIDTH) break;
  }

  return clamp(Math.ceil(maxWidth), MIN_COL_WIDTH, MAX_COL_WIDTH);
};

// Style cache for width styles (avoid object creation in render)
const widthStyleCache = new Map<number, { width: string }>();

export const getWidthStyle = (width: number): { width: string } => {
  let style = widthStyleCache.get(width);
  if (!style) {
    style = { width: `${width}px` };
    widthStyleCache.set(width, style);
  }
  return style;
};
