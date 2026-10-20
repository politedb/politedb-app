import type { DiagramState } from "./diagramTypes";

import {
  HEADER_HEIGHT,
  layoutDiagram,
  ROW_HEIGHT,
  type RelationGeometry,
} from "./diagramLayout";

const REL_STROKE_WIDTH = 0.85;
const CROW_INWARD = 5;
const CROW_BRANCH = 4;
const ONE_MARK_TICK = 5;
const ONE_MARK_INSET = 5;
const O_MARK_R = 3.5;
const O_MARK_INSET = 9;

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

/**
 * The diagram as a standalone SVG, laid out and routed exactly like the canvas.
 * Relations are drawn first so table cards always sit on top of them.
 */
export function buildDiagramSvg(state: DiagramState) {
  const { layout, routes } = layoutDiagram(state.tables, state.relations);
  const relations = state.relations
    .map((relation, index) => {
      const geometry = routes[index];
      if (!geometry) return "";
      const stroke = "#94a3b8";
      let extras = "";
      if (relation.cardinality === "one-to-one") {
        const startDirection = geometry.fromRight ? 1 : -1;
        // Outward from the target card, on the side the relation enters.
        const endDirection = geometry.enterFrom === "left" ? -1 : 1;
        extras = `<circle cx="${geometry.startX + startDirection * O_MARK_INSET}" cy="${geometry.startY}" r="${O_MARK_R}" fill="none" stroke="${stroke}" stroke-width="${REL_STROKE_WIDTH}" /><circle cx="${geometry.endX + endDirection * O_MARK_INSET}" cy="${geometry.endY}" r="${O_MARK_R}" fill="none" stroke="${stroke}" stroke-width="${REL_STROKE_WIDTH}" />`;
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
      ${relations}
      ${cards}
    </svg>`;
}

/**
 * The diagram's structure as JSON: tables with their columns and primary keys, and the
 * relationships between them (from foreign keys).
 */
export function buildDiagramJson(
  state: DiagramState,
  source: { database?: string | null; schema?: string | null } = {}
) {
  const document = {
    format: "politedb.er-diagram",
    version: 1,
    database: source.database ?? null,
    schema: source.schema ?? null,
    tables: state.tables.map((table) => ({
      schema: table.schema,
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        primaryKey: Boolean(column.isPrimaryKey),
      })),
    })),
    relationships: state.relations.map((relation) => ({
      fromTable: relation.fromTable,
      fromColumn: relation.fromColumn ?? null,
      toTable: relation.toTable,
      toColumn: relation.toColumn ?? null,
      cardinality: relation.cardinality,
      label: relation.label,
    })),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
