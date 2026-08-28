import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { writeFile } from "src/lib/system-fs";
import { Button } from "src/components/common/Button";
import { OverlayModal } from "src/components/modal/OverlayModal";
import { DiagramCanvas } from "src/components/DiagramCanvas";
import { DownloadIcon, RefreshCwIcon, XIcon } from "src/components/icons";
import {
  diagramTableColumnsQuery,
  tableColumnsQuery,
  tableConstraintsMySqlQuery,
  tableConstraintsQuery,
  tableForeignKeysQuery,
} from "src/lib/queries/sql";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { runSqlQuery } from "src/lib/tauri/query";
import { saveDialog, showMessage } from "src/lib/system-dialog";
import type { DatabaseEngine, ForeignKeyInfo } from "src/types";
import { cellToString } from "src/utils/convert";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { mapPool } from "src/utils/mapPool";

type DiagramGeneratorDialogProps = {
  open: boolean;
  onClose: () => void;
  engine?: DatabaseEngine;
  database?: string;
  schema: string;
  connectionId?: string;
  metaKey: string;
  metadata: MetadataApi;
};

type DiagramColumn = {
  name: string;
  type: string;
  isPrimaryKey?: boolean;
};

type DiagramTable = {
  schema: string;
  name: string;
  columns: DiagramColumn[];
};

type RelationCardinality = "one-to-one" | "one-to-many";

type DiagramRelation = {
  fromTable: string;
  toTable: string;
  label: string;
  /** Referenced column on parent (first column if composite FK) */
  fromColumn?: string;
  /** Foreign-key column on child (first column if composite FK) */
  toColumn?: string;
  cardinality: RelationCardinality;
};

type DiagramState = {
  mermaid: string;
  tableCount: number;
  relationshipCount: number;
  tables: DiagramTable[];
  relations: DiagramRelation[];
};

type LayoutItem = {
  key: string;
  table: DiagramTable;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Column index (0..n-1), used for relation curve direction */
  column: number;
};

const CARD_WIDTH = 280;
const HEADER_HEIGHT = 42;
const ROW_HEIGHT = 28;
const DIAGRAM_PAD = 32;
const EMPTY_DIAGRAM_WIDTH = 640;
const EMPTY_DIAGRAM_HEIGHT = 400;
/** Horizontal gap between table columns */
const COLUMN_H_GAP = 48;
const ROW_GAP = 48;
/** Relation line (canvas + PNG export) */
const REL_STROKE_WIDTH = 0.85;
/** Invisible hit target (must be fully transparent — low-alpha gray reads as a “shadow”) */
/** Invisible hit target so thin lines are easy to hover */
const CROW_INWARD = 5;
const CROW_BRANCH = 4;
/** Barker-style “one” tick on the parent (1:n) */
const ONE_MARK_TICK = 5;
const ONE_MARK_INSET = 5;
/** Radius used to round relation elbows */
const REL_CORNER_RADIUS = 10;
/** Hollow circles for 1:1 (optional-style O on the line) */
const O_MARK_R = 3.5;
const O_MARK_INSET = 9;
const DIAGRAM_METADATA_CONCURRENCY = 8;

function sanitizeEntityName(name: string) {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function splitCsv(value: string | null | undefined) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Sorted, lowercased column set key for matching FK columns to a UNIQUE/PK index. */
function fkColumnSignature(columnNamesCsv: string): string {
  return splitCsv(columnNamesCsv)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
}

function diagramConstraintsSql(
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
): string | null {
  if (
    !engine ||
    engine === "mongo" ||
    engine === "cassandra" ||
    engine === "redis"
  )
    return null;
  if (engine === "mysql" || engine === "mariadb") {
    return tableConstraintsMySqlQuery(schema, tableName);
  }
  return tableConstraintsQuery(schema, tableName, engine);
}

/** One row from tableConstraintsQuery / tableConstraintsMySqlQuery → unique column signature, or null. */
function uniqueColumnSignatureFromConstraintRow(
  row: unknown[],
  engine?: DatabaseEngine
): string | null {
  let isUniqueLike = false;
  let colPart = "";

  if (engine === "mysql" || engine === "mariadb") {
    const nonUnique = Number(cellToString(row?.[2]) ?? "1");
    const isPrimary = cellToString(row?.[3])?.toLowerCase() === "true";
    isUniqueLike = nonUnique === 0 || isPrimary;
    colPart = cellToString(row?.[4]) ?? "";
  } else {
    isUniqueLike =
      cellIsTruthyPrimary(row?.[2]) || cellIsTruthyPrimary(row?.[3]);
    colPart = cellToString(row?.[5]) ?? "";
  }

  if (!isUniqueLike) return null;
  return fkColumnSignature(colPart);
}

function tableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

function estimateCardHeight(columnCount: number) {
  return HEADER_HEIGHT + Math.max(1, columnCount) * ROW_HEIGHT + 16;
}

function cellIsTruthyPrimary(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const s = cellToString(value as never)
    ?.toLowerCase()
    .trim();
  return s === "true" || s === "t" || s === "1" || s === "yes";
}

function mapForeignKeyRows(rows: unknown[][]): ForeignKeyInfo[] {
  return (rows ?? [])
    .map((row: any) => ({
      constraint_name: cellToString(row?.[0]) ?? "",
      table_schema: cellToString(row?.[1]) ?? "",
      table_name: cellToString(row?.[2]) ?? "",
      column_names: cellToString(row?.[3]) ?? "",
      ref_table_schema: cellToString(row?.[4]) ?? "",
      ref_table_name: cellToString(row?.[5]) ?? "",
      ref_column_names: cellToString(row?.[6]) ?? "",
      on_update: cellToString(row?.[7]) ?? "",
      on_delete: cellToString(row?.[8]) ?? "",
    }))
    .filter((item) => item.table_name && item.ref_table_name);
}

/** Same FK can appear once per table query when flattening chunks — keep one row per logical link. */
function dedupeForeignKeys(fks: ForeignKeyInfo[]): ForeignKeyInfo[] {
  const seen = new Set<string>();
  const out: ForeignKeyInfo[] = [];
  for (const fk of fks) {
    const key = [
      fk.table_schema,
      fk.table_name,
      fk.column_names.trim().toLowerCase(),
      fk.ref_table_schema,
      fk.ref_table_name,
      fk.ref_column_names.trim().toLowerCase(),
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fk);
  }
  return out;
}

function buildMermaid(
  schema: string,
  tables: DiagramTable[],
  fks: ForeignKeyInfo[]
) {
  const entityNameByTable = new Map<string, string>();
  const lines: string[] = [];

  for (const table of tables) {
    const key = tableKey(schema, table.name);
    const tableIdent = sanitizeEntityName(table.name);
    entityNameByTable.set(key, tableIdent);
    lines.push(`Table ${tableIdent} {`);
    if (table.columns.length === 0) {
      lines.push("  _empty varchar");
    } else {
      for (const column of table.columns) {
        const colIdent = sanitizeEntityName(column.name);
        const typ = column.type;
        const pk = column.isPrimaryKey ? " [primary key]" : "";
        lines.push(`  ${colIdent} ${typ}${pk}`);
      }
    }
    lines.push("}");
    lines.push("");
  }

  const seenRefLines = new Set<string>();

  for (const fk of fks) {
    const leftKey = `${fk.table_schema}.${fk.table_name}`;
    const rightKey = `${fk.ref_table_schema}.${fk.ref_table_name}`;
    const child = entityNameByTable.get(leftKey);
    const parent = entityNameByTable.get(rightKey);
    if (!child || !parent) continue;

    const cols = splitCsv(fk.column_names);
    const refCols = splitCsv(fk.ref_column_names);
    const pairCount = Math.max(cols.length, refCols.length, 1);

    for (let i = 0; i < pairCount; i += 1) {
      const childCol = cols[i] ?? cols[0] ?? "id";
      const parentCol = refCols[i] ?? refCols[0] ?? "id";
      const line = `Ref: ${child}.${sanitizeEntityName(childCol)} > ${parent}.${sanitizeEntityName(parentCol)}`;
      if (seenRefLines.has(line)) continue;
      seenRefLines.add(line);
      lines.push(line);
    }
  }

  return lines.join("\n").trimEnd();
}

function buildRelations(
  fks: ForeignKeyInfo[],
  uniqueByChildTable: Map<string, Set<string>>
): DiagramRelation[] {
  return fks.map((fk) => {
    const fkCols = splitCsv(fk.column_names);
    const refCols = splitCsv(fk.ref_column_names);
    const childKey = tableKey(fk.table_schema, fk.table_name);
    const sig = fkColumnSignature(fk.column_names);
    const uniqueSet = uniqueByChildTable.get(childKey);
    const isOneToOne = Boolean(uniqueSet?.has(sig));

    return {
      // Draw arrow from referenced table to referencing table.
      fromTable: `${fk.ref_table_schema}.${fk.ref_table_name}`,
      toTable: `${fk.table_schema}.${fk.table_name}`,
      label: fkCols.join(", ") || fk.constraint_name,
      fromColumn: refCols[0],
      toColumn: fkCols[0],
      cardinality: isOneToOne ? "one-to-one" : "one-to-many",
    };
  });
}

/** Tighten width/height to content + padding (fixes huge canvas for one table). */
function normalizeLayoutBounds(items: LayoutItem[]): {
  items: LayoutItem[];
  width: number;
  height: number;
} {
  if (items.length === 0) {
    return { items, width: EMPTY_DIAGRAM_WIDTH, height: EMPTY_DIAGRAM_HEIGHT };
  }

  const minX = Math.min(...items.map((i) => i.x));
  const minY = Math.min(...items.map((i) => i.y));
  const maxX = Math.max(...items.map((i) => i.x + i.width));
  const maxY = Math.max(...items.map((i) => i.y + i.height));

  const shifted = items.map((item) => ({
    ...item,
    x: item.x - minX + DIAGRAM_PAD,
    y: item.y - minY + DIAGRAM_PAD,
  }));

  return {
    items: shifted,
    width: Math.max(
      maxX - minX + DIAGRAM_PAD * 2,
      CARD_WIDTH + DIAGRAM_PAD * 2
    ),
    height: Math.max(maxY - minY + DIAGRAM_PAD * 2, 120),
  };
}

/** More tables → more columns so cards use horizontal space instead of one tall stack. */
function chooseColumnCount(tableCount: number): number {
  if (tableCount <= 1) return 1;
  const targetPerCol = 6;
  const minCols = 2;
  const maxCols = 12;
  return Math.min(
    maxCols,
    Math.max(minCols, Math.ceil(tableCount / targetPerCol))
  );
}

function columnXPositions(numColumns: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < numColumns; i++) {
    xs.push(DIAGRAM_PAD + i * (CARD_WIDTH + COLUMN_H_GAP));
  }
  return xs;
}

function buildLayout(tables: DiagramTable[], relations: DiagramRelation[]) {
  if (tables.length === 0) {
    return {
      items: [] as LayoutItem[],
      width: EMPTY_DIAGRAM_WIDTH,
      height: EMPTY_DIAGRAM_HEIGHT,
    };
  }

  const degree = new Map<string, number>();
  for (const table of tables) degree.set(tableKey(table.schema, table.name), 0);
  for (const relation of relations) {
    degree.set(relation.fromTable, (degree.get(relation.fromTable) ?? 0) + 1);
    degree.set(relation.toTable, (degree.get(relation.toTable) ?? 0) + 1);
  }

  const numColumns = chooseColumnCount(tables.length);
  const colXs = columnXPositions(numColumns);
  const columns: DiagramTable[][] = Array.from(
    { length: numColumns },
    () => []
  );

  const sorted = tables.slice().sort((a, b) => {
    const aKey = tableKey(a.schema, a.name);
    const bKey = tableKey(b.schema, b.name);
    const d = (degree.get(bKey) ?? 0) - (degree.get(aKey) ?? 0);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });

  sorted.forEach((table, i) => {
    columns[i % numColumns]!.push(table);
  });

  const items: LayoutItem[] = [];
  columns.forEach((columnTables, columnIndex) => {
    let y = DIAGRAM_PAD;
    for (const table of columnTables) {
      const height = estimateCardHeight(table.columns.length);
      items.push({
        key: tableKey(table.schema, table.name),
        table,
        x: colXs[columnIndex]!,
        y,
        width: CARD_WIDTH,
        height,
        column: columnIndex,
      });
      y += height + ROW_GAP;
    }
  });

  return normalizeLayoutBounds(items);
}

/** Vertical center of a column row inside a card (absolute coords). */
function yMidForTableColumn(
  item: LayoutItem,
  columnName: string | undefined
): number {
  const fallback = item.y + item.height / 2;
  const raw = columnName?.trim();
  if (!raw) return fallback;
  const needle = raw.toLowerCase();
  const idx = item.table.columns.findIndex(
    (c) => c.name.trim().toLowerCase() === needle
  );
  if (idx < 0) return fallback;
  return item.y + HEADER_HEIGHT + idx * ROW_HEIGHT + ROW_HEIGHT / 2;
}

type RelationGeometry = {
  path: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  enterFrom: "left" | "right";
  /** Parent card is left of child in layout columns */
  fromRight: boolean;
};

function roundedOrthogonalPath(
  points: Array<{ x: number; y: number }>,
  radius: number
): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  }

  const path: string[] = [`M ${points[0]!.x} ${points[0]!.y}`];

  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;

    const inDx = curr.x - prev.x;
    const inDy = curr.y - prev.y;
    const outDx = next.x - curr.x;
    const outDy = next.y - curr.y;

    const inLen = Math.hypot(inDx, inDy);
    const outLen = Math.hypot(outDx, outDy);
    if (inLen === 0 || outLen === 0) continue;

    const trim = Math.min(radius, inLen / 2, outLen / 2);
    const inUx = inDx / inLen;
    const inUy = inDy / inLen;
    const outUx = outDx / outLen;
    const outUy = outDy / outLen;

    const sx = curr.x - inUx * trim;
    const sy = curr.y - inUy * trim;
    const ex = curr.x + outUx * trim;
    const ey = curr.y + outUy * trim;

    path.push(`L ${sx} ${sy}`);
    path.push(`Q ${curr.x} ${curr.y} ${ex} ${ey}`);
  }

  const last = points[points.length - 1]!;
  path.push(`L ${last.x} ${last.y}`);
  return path.join(" ");
}

function relationGeometry(
  from: LayoutItem,
  to: LayoutItem,
  relation: DiagramRelation
): RelationGeometry {
  const fromRight = from.column <= to.column;
  const startX = fromRight ? from.x + from.width : from.x;
  const startY = yMidForTableColumn(from, relation.fromColumn);
  const endX = fromRight ? to.x : to.x + to.width;
  const endY = yMidForTableColumn(to, relation.toColumn);

  const startOffset = fromRight ? 26 : -26;
  const endOffset = fromRight ? -26 : 26;
  const middleY = (startY + endY) / 2;
  const x1 = startX + startOffset;
  const x2 = endX + endOffset;

  const path = roundedOrthogonalPath(
    [
      { x: startX, y: startY },
      { x: x1, y: startY },
      { x: x1, y: middleY },
      { x: x2, y: middleY },
      { x: x2, y: endY },
      { x: endX, y: endY },
    ],
    REL_CORNER_RADIUS
  );

  return {
    path,
    startX,
    startY,
    endX,
    endY,
    enterFrom: fromRight ? "left" : "right",
    fromRight,
  };
}

function crowFootLines(
  x: number,
  y: number,
  enterFrom: "left" | "right"
): Array<[number, number, number, number]> {
  const inward = enterFrom === "left" ? -CROW_INWARD : CROW_INWARD;
  const baseX = x + inward;
  return [
    [baseX, y, x, y],
    [baseX, y, x, y - CROW_BRANCH],
    [baseX, y, x, y + CROW_BRANCH],
  ];
}

function oneToManyParentTickGeometry(g: RelationGeometry): {
  x: number;
  y1: number;
  y2: number;
} {
  const x = g.fromRight ? g.startX + ONE_MARK_INSET : g.startX - ONE_MARK_INSET;
  return {
    x,
    y1: g.startY - ONE_MARK_TICK,
    y2: g.startY + ONE_MARK_TICK,
  };
}

function oneToOneCircleCenters(g: RelationGeometry): {
  startCx: number;
  startCy: number;
  endCx: number;
  endCy: number;
} {
  if (g.fromRight) {
    return {
      startCx: g.startX + O_MARK_INSET,
      startCy: g.startY,
      endCx: g.endX - O_MARK_INSET,
      endCy: g.endY,
    };
  }
  return {
    startCx: g.startX - O_MARK_INSET,
    startCy: g.startY,
    endCx: g.endX + O_MARK_INSET,
    endCy: g.endY,
  };
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildDiagramSvg(state: DiagramState) {
  const layout = buildLayout(state.tables, state.relations);
  const itemByKey = new Map(layout.items.map((item) => [item.key, item]));

  const relations = state.relations
    .map((relation, index) => {
      const from = itemByKey.get(relation.fromTable);
      const to = itemByKey.get(relation.toTable);
      if (!from || !to) return "";
      const g = relationGeometry(from, to, relation);
      const stroke = "#94a3b8";
      const sw = REL_STROKE_WIDTH;

      let extras = "";
      if (relation.cardinality === "one-to-one") {
        const o = oneToOneCircleCenters(g);
        extras = `<circle cx="${o.startCx}" cy="${o.startCy}" r="${O_MARK_R}" fill="none" stroke="${stroke}" stroke-width="${sw}" /><circle cx="${o.endCx}" cy="${o.endCy}" r="${O_MARK_R}" fill="none" stroke="${stroke}" stroke-width="${sw}" />`;
      } else {
        const t = oneToManyParentTickGeometry(g);
        extras = `<line x1="${t.x}" y1="${t.y1}" x2="${t.x}" y2="${t.y2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" />`;
        extras += crowFootLines(g.endX, g.endY, g.enterFrom)
          .map(
            ([x1, y1, x2, y2]) =>
              `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" />`
          )
          .join("");
      }

      return `<g id="rel-${index}"><path d="${g.path}" fill="none" stroke="${stroke}" stroke-width="${sw}" />${extras}</g>`;
    })
    .filter(Boolean)
    .join("");

  const cards = layout.items
    .map((item) => {
      const rows = item.table.columns
        .map((column, index) => {
          const rowY = HEADER_HEIGHT + index * ROW_HEIGHT;
          const pk = Boolean(column.isPrimaryKey);
          const nameX = pk ? 30 : 16;
          const keyG = pk
            ? `<g transform="translate(7, ${rowY + 3}) scale(0.48)" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></g>`
            : "";
          return `
            <line x1="0" y1="${rowY}" x2="${item.width}" y2="${rowY}" stroke="#f1f5f9" />
            ${keyG}
            <text x="${nameX}" y="${rowY + 18}" font-size="12" fill="#334155">${escapeXml(column.name)}</text>
            <text x="${item.width - 16}" y="${rowY + 18}" font-size="12" text-anchor="end" fill="#94a3b8">${escapeXml(column.type || "unknown")}</text>
          `;
        })
        .join("");

      return `
        <g transform="translate(${item.x}, ${item.y})">
          <rect width="${item.width}" height="${item.height}" rx="12" ry="12" fill="#ffffff" stroke="#e2e8f0" />
          <rect width="${item.width}" height="${HEADER_HEIGHT}" rx="12" ry="12" fill="#f8fafc" />
          <rect y="${HEADER_HEIGHT - 12}" width="${item.width}" height="12" fill="#f8fafc" />
          <line x1="0" y1="${HEADER_HEIGHT}" x2="${item.width}" y2="${HEADER_HEIGHT}" stroke="#e2e8f0" />
          <text x="${item.width / 2}" y="24" font-size="14" font-weight="600" text-anchor="middle" fill="#1e293b">${escapeXml(item.table.name)}</text>
          ${rows}
        </g>
      `;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" fill="none">
      <defs>
        <pattern id="diagram-grid" width="18" height="18" patternUnits="userSpaceOnUse">
          <rect width="18" height="18" fill="#fcfcfd" />
          <circle cx="1" cy="1" r="1" fill="#e2e8f0" />
        </pattern>
      </defs>
      <rect width="${layout.width}" height="${layout.height}" fill="url(#diagram-grid)" />
      ${cards}
      ${relations}
    </svg>`;
}

export function DiagramGeneratorDialog(props: DiagramGeneratorDialogProps) {
  const {
    open,
    onClose,
    engine,
    database,
    schema,
    connectionId,
    metaKey,
    metadata,
  } = props;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [diagram, setDiagram] = useState<DiagramState | null>(null);

  const disabled = !connectionId || !schema || engine === "redis";

  const loadDiagram = useCallback(async () => {
    if (disabled || !connectionId || !engine || !schema) return;

    setLoading(true);
    setError(null);
    setCopied(false);

    try {
      const meta = await metadata.load({
        metaKey,
        engine,
        connectionId,
        includeColumns: true,
      });

      const schemaTables = (meta.tables ?? []).filter(
        (table) => table.schema === schema
      );

      const loaded = await mapPool(
        schemaTables,
        DIAGRAM_METADATA_CONCURRENCY,
        async (table) => {
          const pkQuery = diagramTableColumnsQuery(schema, table.name, engine);
          const sql = pkQuery ?? tableColumnsQuery(schema, table.name, engine);
          const csql =
            engine === "mongo"
              ? null
              : diagramConstraintsSql(schema, table.name, engine);

          const [colRes, fkRes, constraintRes] = await Promise.all([
            runSqlQuery(connectionId, sql, { batchSize: 500 }),
            engine === "mongo"
              ? Promise.resolve(null)
              : runSqlQuery(
                  connectionId,
                  tableForeignKeysQuery(schema, table.name, engine),
                  { batchSize: 200 }
                ),
            csql
              ? runSqlQuery(connectionId, csql, { batchSize: 400 }).catch(
                  () => null
                )
              : Promise.resolve(null),
          ]);

          const columns: DiagramColumn[] = (colRes.rows ?? []).map(
            (row: any) => ({
              name: cellToString(row?.[0]) ?? "",
              type: cellToString(row?.[1]) ?? "",
              isPrimaryKey: pkQuery ? cellIsTruthyPrimary(row?.[2]) : false,
            })
          );

          const uniqueSignatures: string[] = [];
          for (const row of constraintRes?.rows ?? []) {
            const sig = uniqueColumnSignatureFromConstraintRow(
              row as unknown[],
              engine
            );
            if (sig) uniqueSignatures.push(sig);
          }

          return {
            table: {
              schema,
              name: table.name,
              columns: columns.filter((column) => column.name),
            },
            foreignKeys:
              fkRes === null ? [] : mapForeignKeyRows(fkRes.rows ?? []),
            uniqueSignatures,
          };
        }
      );

      const tables = loaded.map((item) => item.table);
      const foreignKeys = dedupeForeignKeys(
        loaded.flatMap((item) => item.foreignKeys)
      );
      const uniqueByChildTable = new Map<string, Set<string>>();
      for (const item of loaded) {
        if (item.uniqueSignatures.length === 0) continue;
        uniqueByChildTable.set(
          tableKey(schema, item.table.name),
          new Set(item.uniqueSignatures)
        );
      }

      const mermaid = buildMermaid(schema, tables, foreignKeys);
      const relations = buildRelations(foreignKeys, uniqueByChildTable);

      setDiagram({
        mermaid,
        tableCount: tables.length,
        relationshipCount: relations.length,
        tables,
        relations,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDiagram(null);
    } finally {
      setLoading(false);
    }
  }, [connectionId, disabled, engine, metaKey, metadata, schema]);

  useEffect(() => {
    if (!open) return;
    void loadDiagram();
  }, [open, connectionId, engine, schema, metaKey, loadDiagram]);

  const subtitle = useMemo(() => {
    if (!diagram) return "";
    return `${diagram.tableCount} tables • ${diagram.relationshipCount} relationships`;
  }, [diagram]);

  const exportBaseName = useMemo(
    () => [database, schema, "diagram"].filter(Boolean).join("-"),
    [database, schema]
  );

  async function handleCopy() {
    if (!diagram?.mermaid) return;
    try {
      await navigator.clipboard.writeText(diagram.mermaid);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      await showMessage(String(err), { title: "Copy failed", kind: "error" });
    }
  }

  async function handleDownloadPng() {
    if (!diagram) return;
    let objectUrl: string | null = null;
    try {
      const path = await saveDialog({
        title: "Export PNG",
        defaultPath: `${exportBaseName || "diagram"}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!path) return;

      const svg = buildDiagramSvg(diagram);
      const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      objectUrl = URL.createObjectURL(svgBlob);

      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Failed to render SVG."));
        image.src = objectUrl!;
      });

      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = image.width * scale;
      canvas.height = image.height * scale;

      const context = canvas.getContext("2d");
      if (!context) throw new Error("Failed to create PNG canvas.");
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.drawImage(image, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png")
      );
      if (!blob) throw new Error("Failed to encode PNG.");
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));

      await showMessage("PNG exported.", {
        title: "Export completed",
        kind: "info",
      });
    } catch (err) {
      await showMessage(String(err), { title: "Export failed", kind: "error" });
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  return (
    <OverlayModal open={open} onClose={onClose}>
      <div class="flex h-[85vh] w-full max-w-10/12 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div class="flex shrink-0 items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <div class="text-xl font-semibold text-slate-900">
              Generate Diagram
            </div>
            <div class="mt-1 text-sm text-slate-500">
              {schema
                ? `Visual ER diagram for ${schema}.`
                : "Visual ER diagram for the current schema."}
            </div>
            {subtitle ? (
              <div class="mt-2 text-xs font-medium text-slate-400">
                {subtitle}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onClose}
            class="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close diagram dialog"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-hidden">
          <div class="flex h-full min-h-0 flex-col overflow-hidden px-5 py-4">
            {disabled ? (
              <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300">
                Diagram generation is available for database schemas with
                tables.
              </div>
            ) : loading ? (
              <div class="flex min-h-0 flex-1 items-center justify-center">
                <div class="text-center">
                  <div class="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600 dark:border-slate-700 dark:border-t-sky-400" />
                  <div class="mt-4 text-sm text-slate-500">
                    Building diagram from schema metadata...
                  </div>
                </div>
              </div>
            ) : error ? (
              <div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-300">
                {error}
              </div>
            ) : diagram ? (
              <div class="flex min-h-0 flex-1 gap-3">
                <div class="flex min-h-0 w-1/3 min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  <button
                    type="button"
                    class="flex w-full shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <span>Database Structure</span>
                  </button>

                  <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
                    <div class="group relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                      <button
                        type="button"
                        onClick={() => void handleCopy()}
                        class="absolute top-3 right-3 z-10 hidden rounded-md border border-slate-700 bg-slate-900/90 px-2.5 py-1 text-xs font-medium text-slate-100 group-hover:block hover:border-slate-500 hover:bg-slate-800"
                      >
                        {copied ? "Copied" : "Copy"}
                      </button>
                      <OverlayScrollArea
                        className="min-h-0 flex-1 rounded-lg bg-slate-800"
                        contentClassName="p-4 text-xs leading-6 whitespace-pre text-slate-100"
                        horizontal
                        vertical
                      >
                        {diagram.mermaid}
                      </OverlayScrollArea>
                    </div>
                  </div>
                </div>

                <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                  <DiagramCanvas state={diagram} />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div class="flex shrink-0 items-center justify-between border-t border-slate-200 px-5 py-4">
          <div class="text-xs text-slate-400">
            Relationships are generated from foreign keys when supported.
          </div>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void loadDiagram()}
              disabled={disabled || loading}
              class="h-9 rounded-lg px-3"
            >
              <RefreshCwIcon className="size-4" />
              Refresh
            </Button>
            <Button
              variant="default"
              onClick={() => void handleDownloadPng()}
              disabled={!diagram || loading}
              class="h-9 rounded-lg px-3"
            >
              <DownloadIcon className="size-4" />
              Export as PNG
            </Button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
