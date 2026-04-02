import { useEffect, useMemo, useState } from "preact/hooks";
import { writeFile } from "@tauri-apps/plugin-fs";
import { Button } from "src/components/common/Button";
import { OverlayModal } from "src/components/modal/OverlayModal";
import {
  ChevronDown,
  ChevronRight,
  DownloadIcon,
  RefreshCw,
  X,
} from "src/components/icons";
import { tableColumnsQuery, tableForeignKeysQuery } from "src/hooks/queries";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { runSqlQuery } from "src/lib/tauri/query";
import { saveDialog, showMessage } from "src/lib/system-dialog";
import type { DatabaseEngine, ForeignKeyInfo } from "src/types";
import { cellToString } from "src/utils/convert";

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
};

type DiagramTable = {
  schema: string;
  name: string;
  columns: DiagramColumn[];
};

type DiagramRelation = {
  fromTable: string;
  toTable: string;
  label: string;
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
  column: 0 | 1 | 2;
};

const CARD_WIDTH = 280;
const HEADER_HEIGHT = 42;
const ROW_HEIGHT = 28;
const MIN_CANVAS_HEIGHT = 720;
const COLUMN_X = [32, 390, 748];
const ROW_GAP = 48;

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

function tableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

function estimateCardHeight(columnCount: number) {
  return HEADER_HEIGHT + Math.max(1, columnCount) * ROW_HEIGHT + 16;
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

function buildMermaid(
  schema: string,
  tables: DiagramTable[],
  fks: ForeignKeyInfo[]
) {
  const entityNameByTable = new Map<string, string>();
  const lines: string[] = ["Entities"];

  for (const table of tables) {
    const key = tableKey(schema, table.name);
    const entityName = sanitizeEntityName(table.name);
    entityNameByTable.set(key, entityName);
    lines.push(`  ${entityName} {`);
    if (table.columns.length === 0) {
      lines.push("    string _");
    } else {
      for (const column of table.columns) {
        lines.push(
          `    ${sanitizeEntityName(column.type || "string")} ${sanitizeEntityName(column.name)}`
        );
      }
    }
    lines.push("  }");
  }

  if (tables.length > 0) lines.push("");

  for (const fk of fks) {
    const leftKey = `${fk.table_schema}.${fk.table_name}`;
    const rightKey = `${fk.ref_table_schema}.${fk.ref_table_name}`;
    const left = entityNameByTable.get(leftKey);
    const right = entityNameByTable.get(rightKey);
    if (!left || !right) continue;
    const label = splitCsv(fk.column_names).join(", ") || fk.constraint_name;
    lines.push(`  ${right} ||--o{ ${left} : "${label}"`);
  }

  return lines.join("\n");
}

function buildRelations(fks: ForeignKeyInfo[]): DiagramRelation[] {
  return fks.map((fk) => ({
    fromTable: `${fk.table_schema}.${fk.table_name}`,
    toTable: `${fk.ref_table_schema}.${fk.ref_table_name}`,
    label: splitCsv(fk.column_names).join(", ") || fk.constraint_name,
  }));
}

function buildLayout(tables: DiagramTable[], relations: DiagramRelation[]) {
  if (tables.length === 0) {
    return {
      items: [] as LayoutItem[],
      width: 1100,
      height: MIN_CANVAS_HEIGHT,
    };
  }

  const degree = new Map<string, number>();
  for (const table of tables) degree.set(tableKey(table.schema, table.name), 0);
  for (const relation of relations) {
    degree.set(relation.fromTable, (degree.get(relation.fromTable) ?? 0) + 1);
    degree.set(relation.toTable, (degree.get(relation.toTable) ?? 0) + 1);
  }

  const sortedByDegree = tables.slice().sort((a, b) => {
    const aKey = tableKey(a.schema, a.name);
    const bKey = tableKey(b.schema, b.name);
    const d = (degree.get(bKey) ?? 0) - (degree.get(aKey) ?? 0);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });

  const hub = sortedByDegree[0]!;
  const hubKey = tableKey(hub.schema, hub.name);
  const directlyConnected = new Set<string>();

  for (const relation of relations) {
    if (relation.fromTable === hubKey) directlyConnected.add(relation.toTable);
    if (relation.toTable === hubKey) directlyConnected.add(relation.fromTable);
  }

  const left: DiagramTable[] = [];
  const right: DiagramTable[] = [];
  const center: DiagramTable[] = [hub];
  const rest: DiagramTable[] = [];

  for (const table of sortedByDegree.slice(1)) {
    const key = tableKey(table.schema, table.name);
    if (!directlyConnected.has(key)) {
      rest.push(table);
      continue;
    }
    if (left.length <= right.length) left.push(table);
    else right.push(table);
  }

  for (const table of rest) {
    if (center.length <= 2) center.push(table);
    else if (left.length <= right.length) left.push(table);
    else right.push(table);
  }

  const items: LayoutItem[] = [];
  const columns: Array<DiagramTable[]> = [left, center, right];
  let maxHeight = MIN_CANVAS_HEIGHT;

  columns.forEach((columnTables, columnIndex) => {
    let y = columnIndex === 1 ? 140 : 32;
    for (const table of columnTables) {
      const height = estimateCardHeight(table.columns.length);
      items.push({
        key: tableKey(table.schema, table.name),
        table,
        x: COLUMN_X[columnIndex]!,
        y,
        width: CARD_WIDTH,
        height,
        column: columnIndex as 0 | 1 | 2,
      });
      y += height + ROW_GAP;
      maxHeight = Math.max(maxHeight, y + 40);
    }
  });

  return {
    items,
    width: COLUMN_X[2]! + CARD_WIDTH + 48,
    height: maxHeight,
  };
}

function relationPath(from: LayoutItem, to: LayoutItem) {
  const fromRight = from.column <= to.column;
  const startX = fromRight ? from.x + from.width : from.x;
  const startY = from.y + from.height / 2;
  const endX = fromRight ? to.x : to.x + to.width;
  const endY = to.y + to.height / 2;
  const delta = Math.max(28, Math.abs(endX - startX) / 2);
  const c1x = fromRight ? startX + delta : startX - delta;
  const c2x = fromRight ? endX - delta : endX + delta;
  return `M ${startX} ${startY} C ${c1x} ${startY}, ${c2x} ${endY}, ${endX} ${endY}`;
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
      return `<path id="rel-${index}" d="${relationPath(from, to)}" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#diagram-arrow)" />`;
    })
    .filter(Boolean)
    .join("");

  const cards = layout.items
    .map((item) => {
      const rows = item.table.columns
        .map((column, index) => {
          const rowY = HEADER_HEIGHT + index * ROW_HEIGHT;
          return `
            <line x1="0" y1="${rowY}" x2="${item.width}" y2="${rowY}" stroke="#f1f5f9" />
            <text x="16" y="${rowY + 18}" font-size="12" fill="#334155">${escapeXml(column.name)}</text>
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
        <marker id="diagram-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
        </marker>
      </defs>
      <rect width="${layout.width}" height="${layout.height}" fill="url(#diagram-grid)" />
      ${relations}
      ${cards}
    </svg>`;
}

function DiagramCanvas(props: { state: DiagramState }) {
  const { state } = props;
  const layout = useMemo(
    () => buildLayout(state.tables, state.relations),
    [state.tables, state.relations]
  );
  const itemByKey = useMemo(
    () => new Map(layout.items.map((item) => [item.key, item])),
    [layout.items]
  );

  return (
    <div class="w-full overflow-auto rounded-2xl border border-slate-200 bg-white">
      <div
        class="min-w-full"
        style={{
          height: `${layout.height}px`,
          backgroundSize: "18px 18px",
          backgroundColor: "#fcfcfd",
        }}
      >
        <div
          class="min-h-full px-8"
          style={{
            width: `max(100%, ${layout.width + 64}px)`,
          }}
        >
          <div
            class="relative mx-auto"
            style={{
              width: `${layout.width}px`,
              height: `${layout.height}px`,
            }}
          >
            <svg
              class="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              <defs>
                <marker
                  id="diagram-arrow"
                  markerWidth="10"
                  markerHeight="10"
                  refX="8"
                  refY="5"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
                </marker>
              </defs>
              {state.relations.map((relation, index) => {
                const from = itemByKey.get(relation.fromTable);
                const to = itemByKey.get(relation.toTable);
                if (!from || !to) return null;
                return (
                  <path
                    key={`${relation.fromTable}-${relation.toTable}-${index}`}
                    d={relationPath(from, to)}
                    fill="none"
                    stroke="#94a3b8"
                    stroke-width="1.5"
                    marker-end="url(#diagram-arrow)"
                  />
                );
              })}
            </svg>

            {layout.items.map((item) => (
              <div
                key={item.key}
                class="absolute overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_10px_24px_rgba(15,23,42,0.06)]"
                style={{
                  left: `${item.x}px`,
                  top: `${item.y}px`,
                  width: `${item.width}px`,
                }}
              >
                <div class="border-b border-slate-200 bg-slate-50 px-4 py-3 text-center text-sm font-semibold text-slate-800">
                  {item.table.name}
                </div>

                <div class="divide-y divide-slate-100">
                  {item.table.columns.map((column) => (
                    <div
                      key={column.name}
                      class="flex items-center justify-between gap-3 px-4 py-2 text-xs"
                    >
                      <span class="min-w-0 flex-1 truncate text-slate-700">
                        {column.name}
                      </span>
                      <span class="shrink-0 font-medium text-slate-400">
                        {column.type || "unknown"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
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
  const [showSource, setShowSource] = useState(false);
  const [diagram, setDiagram] = useState<DiagramState | null>(null);

  const disabled = !connectionId || !schema || engine === "redis";

  const loadDiagram = async () => {
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

      const tables = await Promise.all(
        schemaTables.map(async (table) => {
          const sql = tableColumnsQuery(schema, table.name, engine);
          const res = await runSqlQuery(connectionId, sql, { batchSize: 500 });
          const columns: DiagramColumn[] = (res.rows ?? []).map((row: any) => ({
            name: cellToString(row?.[0]) ?? "",
            type: cellToString(row?.[1]) ?? "",
          }));
          return {
            schema,
            name: table.name,
            columns: columns.filter((column) => column.name),
          };
        })
      );

      let foreignKeys: ForeignKeyInfo[] = [];
      if (engine !== "mongo") {
        const fkChunks = await Promise.all(
          schemaTables.map(async (table) => {
            const sql = tableForeignKeysQuery(schema, table.name, engine);
            const res = await runSqlQuery(connectionId, sql, {
              batchSize: 200,
            });
            return mapForeignKeyRows(res.rows ?? []);
          })
        );
        foreignKeys = fkChunks.flat();
      }

      const mermaid = buildMermaid(schema, tables, foreignKeys);
      const relations = buildRelations(foreignKeys);

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
  };

  useEffect(() => {
    if (!open) return;
    void loadDiagram();
  }, [open, connectionId, engine, schema, metaKey]);

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
        title: "Export complete",
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
            <X className="size-4" />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-hidden">
          <div class="h-full overflow-y-auto px-5 py-4">
            {disabled ? (
              <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                Diagram generation is available for database schemas with
                tables.
              </div>
            ) : loading ? (
              <div class="flex h-80 items-center justify-center">
                <div class="text-center">
                  <div class="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600" />
                  <div class="mt-4 text-sm text-slate-500">
                    Building diagram from schema metadata...
                  </div>
                </div>
              </div>
            ) : error ? (
              <div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                {error}
              </div>
            ) : diagram ? (
              <div class="space-y-4">
                <DiagramCanvas state={diagram} />

                <div class="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  <button
                    type="button"
                    onClick={() => setShowSource((prev) => !prev)}
                    class="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <span>Mermaid Source</span>
                    {showSource ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>

                  {showSource ? (
                    <div class="border-t border-slate-200 p-4">
                      <div class="relative">
                        <button
                          type="button"
                          onClick={() => void handleCopy()}
                          class="absolute top-3 right-3 z-10 rounded-md border border-slate-700 bg-slate-900/90 px-2.5 py-1 text-xs font-medium text-slate-100 hover:border-slate-500 hover:bg-slate-800"
                        >
                          {copied ? "Copied" : "Copy Source"}
                        </button>
                        <pre class="max-h-[32vh] overflow-auto rounded-lg bg-slate-900 p-4 pr-28 text-xs leading-6 wrap-break-word whitespace-pre-wrap text-slate-100">
                          {diagram.mermaid}
                        </pre>
                      </div>
                    </div>
                  ) : null}
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
              <RefreshCw className="size-4" />
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
