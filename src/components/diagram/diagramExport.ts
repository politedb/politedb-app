import type {
  DiagramRelation,
  DiagramState,
  DiagramTable,
} from "./diagramTypes";

type LayoutItem = {
  key: string;
  table: DiagramTable;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
};

type RelationGeometry = {
  path: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  enterFrom: "left" | "right";
  fromRight: boolean;
};

const CARD_WIDTH = 280;
const HEADER_HEIGHT = 42;
const ROW_HEIGHT = 28;
const DIAGRAM_PAD = 32;
const EMPTY_DIAGRAM_WIDTH = 640;
const EMPTY_DIAGRAM_HEIGHT = 400;
const COLUMN_H_GAP = 48;
const ROW_GAP = 48;
const REL_STROKE_WIDTH = 0.85;
const CROW_INWARD = 5;
const CROW_BRANCH = 4;
const ONE_MARK_TICK = 5;
const ONE_MARK_INSET = 5;
const REL_CORNER_RADIUS = 10;
const O_MARK_R = 3.5;
const O_MARK_INSET = 9;

function tableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

function estimateCardHeight(columnCount: number) {
  return HEADER_HEIGHT + Math.max(1, columnCount) * ROW_HEIGHT + 16;
}

function normalizeLayoutBounds(items: LayoutItem[]) {
  if (items.length === 0) {
    return {
      items,
      width: EMPTY_DIAGRAM_WIDTH,
      height: EMPTY_DIAGRAM_HEIGHT,
    };
  }
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
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

function chooseColumnCount(tableCount: number) {
  if (tableCount <= 1) return 1;
  return Math.min(12, Math.max(2, Math.ceil(tableCount / 6)));
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

  const columnCount = chooseColumnCount(tables.length);
  const columns: DiagramTable[][] = Array.from(
    { length: columnCount },
    () => []
  );
  const sorted = tables.slice().sort((left, right) => {
    const degreeDiff =
      (degree.get(tableKey(right.schema, right.name)) ?? 0) -
      (degree.get(tableKey(left.schema, left.name)) ?? 0);
    return degreeDiff || left.name.localeCompare(right.name);
  });
  sorted.forEach((table, index) => {
    columns[index % columnCount]!.push(table);
  });

  const items: LayoutItem[] = [];
  columns.forEach((columnTables, column) => {
    let y = DIAGRAM_PAD;
    for (const table of columnTables) {
      const height = estimateCardHeight(table.columns.length);
      items.push({
        key: tableKey(table.schema, table.name),
        table,
        x: DIAGRAM_PAD + column * (CARD_WIDTH + COLUMN_H_GAP),
        y,
        width: CARD_WIDTH,
        height,
        column,
      });
      y += height + ROW_GAP;
    }
  });
  return normalizeLayoutBounds(items);
}

function columnMidpoint(item: LayoutItem, columnName?: string) {
  const needle = columnName?.trim().toLowerCase();
  if (!needle) return item.y + item.height / 2;
  const index = item.table.columns.findIndex(
    (column) => column.name.trim().toLowerCase() === needle
  );
  return index < 0
    ? item.y + item.height / 2
    : item.y + HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function roundedOrthogonalPath(
  points: Array<{ x: number; y: number }>,
  radius: number
) {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  }
  const path = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    const incomingX = current.x - previous.x;
    const incomingY = current.y - previous.y;
    const outgoingX = next.x - current.x;
    const outgoingY = next.y - current.y;
    const incomingLength = Math.hypot(incomingX, incomingY);
    const outgoingLength = Math.hypot(outgoingX, outgoingY);
    if (incomingLength === 0 || outgoingLength === 0) continue;
    const trim = Math.min(radius, incomingLength / 2, outgoingLength / 2);
    path.push(
      `L ${current.x - (incomingX / incomingLength) * trim} ${current.y - (incomingY / incomingLength) * trim}`,
      `Q ${current.x} ${current.y} ${current.x + (outgoingX / outgoingLength) * trim} ${current.y + (outgoingY / outgoingLength) * trim}`
    );
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
  const startY = columnMidpoint(from, relation.fromColumn);
  const endX = fromRight ? to.x : to.x + to.width;
  const endY = columnMidpoint(to, relation.toColumn);
  const firstX = startX + (fromRight ? 26 : -26);
  const secondX = endX + (fromRight ? -26 : 26);
  const middleY = (startY + endY) / 2;
  return {
    path: roundedOrthogonalPath(
      [
        { x: startX, y: startY },
        { x: firstX, y: startY },
        { x: firstX, y: middleY },
        { x: secondX, y: middleY },
        { x: secondX, y: endY },
        { x: endX, y: endY },
      ],
      REL_CORNER_RADIUS
    ),
    startX,
    startY,
    endX,
    endY,
    enterFrom: fromRight ? "left" : "right",
    fromRight,
  };
}

function crowFootLines(geometry: RelationGeometry) {
  const inward = geometry.enterFrom === "left" ? -CROW_INWARD : CROW_INWARD;
  const baseX = geometry.endX + inward;
  return [
    [baseX, geometry.endY, geometry.endX, geometry.endY],
    [baseX, geometry.endY, geometry.endX, geometry.endY - CROW_BRANCH],
    [baseX, geometry.endY, geometry.endX, geometry.endY + CROW_BRANCH],
  ];
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildDiagramSvg(state: DiagramState) {
  const layout = buildLayout(state.tables, state.relations);
  const itemByKey = new Map(layout.items.map((item) => [item.key, item]));
  const relations = state.relations
    .map((relation, index) => {
      const from = itemByKey.get(relation.fromTable);
      const to = itemByKey.get(relation.toTable);
      if (!from || !to) return "";
      const geometry = relationGeometry(from, to, relation);
      const stroke = "#94a3b8";
      let extras = "";
      if (relation.cardinality === "one-to-one") {
        const direction = geometry.fromRight ? 1 : -1;
        extras = `<circle cx="${geometry.startX + direction * O_MARK_INSET}" cy="${geometry.startY}" r="${O_MARK_R}" fill="none" stroke="${stroke}" stroke-width="${REL_STROKE_WIDTH}" /><circle cx="${geometry.endX - direction * O_MARK_INSET}" cy="${geometry.endY}" r="${O_MARK_R}" fill="none" stroke="${stroke}" stroke-width="${REL_STROKE_WIDTH}" />`;
      } else {
        const tickX =
          geometry.startX +
          (geometry.fromRight ? ONE_MARK_INSET : -ONE_MARK_INSET);
        extras = `<line x1="${tickX}" y1="${geometry.startY - ONE_MARK_TICK}" x2="${tickX}" y2="${geometry.startY + ONE_MARK_TICK}" stroke="${stroke}" stroke-width="${REL_STROKE_WIDTH}" stroke-linecap="round" />`;
        extras += crowFootLines(geometry)
          .map(
            ([x1, y1, x2, y2]) =>
              `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${REL_STROKE_WIDTH}" />`
          )
          .join("");
      }
      return `<g id="rel-${index}"><path d="${geometry.path}" fill="none" stroke="${stroke}" stroke-width="${REL_STROKE_WIDTH}" />${extras}</g>`;
    })
    .filter(Boolean)
    .join("");

  const cards = layout.items
    .map((item) => {
      const rows = item.table.columns
        .map((column, index) => {
          const rowY = HEADER_HEIGHT + index * ROW_HEIGHT;
          const nameX = column.isPrimaryKey ? 30 : 16;
          const keyIcon = column.isPrimaryKey
            ? `<g transform="translate(7, ${rowY + 3}) scale(0.48)" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></g>`
            : "";
          return `
            <line x1="0" y1="${rowY}" x2="${item.width}" y2="${rowY}" stroke="#f1f5f9" />
            ${keyIcon}
            <text x="${nameX}" y="${rowY + 18}" font-size="12" fill="#334155">${escapeXml(column.name)}</text>
            <text x="${item.width - 16}" y="${rowY + 18}" font-size="12" text-anchor="end" fill="#94a3b8">${escapeXml(column.type || "unknown")}</text>`;
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
        </g>`;
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
