/** SQL literal helpers for database backup INSERT statements. */

/**
 * Quote a string as an SQL literal.
 * Postgres (standard_conforming_strings): only `''` escapes quotes — do NOT
 * double backslashes or JSON `\n` / `\"` become `\\n` / `\\"` and fail restore.
 * MySQL/MariaDB: escape both `\` and `'`.
 */
export function sqlQuoteString(value: string, engine?: string): string {
  const e = (engine ?? "").toLowerCase();
  if (e === "postgres" || e === "postgresql") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export function isPostgresArrayType(dbType: string): boolean {
  const t = (dbType ?? "").toLowerCase().trim();
  if (!t) return false;
  return t.startsWith("_") || t.endsWith("[]");
}

export function isPostgresJsonType(dbType: string): boolean {
  const t = (dbType ?? "").toLowerCase().trim();
  return t === "json" || t === "jsonb";
}

/** Map Postgres type name (`_text`, `text[]`) to a cast target like `text[]`. */
export function pgArrayCastType(dbType: string): string {
  const t = (dbType ?? "").toLowerCase().trim();
  if (!t) return "text[]";
  if (t.endsWith("[]")) return t;
  if (t.startsWith("_")) return `${t.slice(1)}[]`;
  return "text[]";
}

/**
 * Convert a JSON array string (how PoliteDB stores PG arrays in CellValue::Json)
 * into `ARRAY[...]::elem[]` SQL that Postgres accepts on restore.
 */
export function jsonArrayToPgArraySql(
  jsonText: string,
  dbType: string,
  engine = "postgres"
): string {
  const cast = pgArrayCastType(dbType);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return `${sqlQuoteString(jsonText, engine)}::${cast}`;
  }

  if (!Array.isArray(parsed)) {
    return `${sqlQuoteString(jsonText, engine)}::${cast}`;
  }

  const elems = parsed.map((item) => {
    if (item === null) return "NULL";
    if (typeof item === "boolean") return item ? "TRUE" : "FALSE";
    if (typeof item === "number" && Number.isFinite(item)) return String(item);
    if (typeof item === "string") return sqlQuoteString(item, engine);
    return sqlQuoteString(JSON.stringify(item), engine);
  });

  return `ARRAY[${elems.join(", ")}]::${cast}`;
}

type CellObj = { t?: string; v?: unknown };

function asCellObj(cell: unknown): CellObj | null {
  if (cell && typeof cell === "object" && "t" in (cell as object)) {
    return cell as CellObj;
  }
  return null;
}

/**
 * Format one cell as an SQL literal for INSERT dumps.
 * Postgres arrays arrive as `{ t: "Json", v: "[...]" }` and must not be
 * written as a quoted JSON string when the column is a PG array type.
 */
export function formatSqlInsertValue(
  cell: unknown,
  opts?: { dbType?: string; engine?: string }
): string {
  if (cell == null) return "NULL";

  const dbType = opts?.dbType ?? "";
  const engine = (opts?.engine ?? "").toLowerCase();
  const obj = asCellObj(cell);

  if (obj?.t === "Null") return "NULL";
  if (obj?.t === "Bool") return obj.v ? "TRUE" : "FALSE";
  if (obj?.t === "I64" || obj?.t === "F64") return String(obj.v);

  if (obj?.t === "Json") {
    const raw = String(obj.v ?? "");
    if (engine === "postgres" && isPostgresArrayType(dbType)) {
      return jsonArrayToPgArraySql(raw, dbType, engine);
    }
    if (engine === "postgres" && isPostgresJsonType(dbType)) {
      return `${sqlQuoteString(raw, engine)}::${dbType.toLowerCase()}`;
    }
    return sqlQuoteString(raw, engine);
  }

  if (obj?.t === "BytesB64") {
    return sqlQuoteString(String(obj.v ?? ""), engine);
  }

  if (obj?.t === "Str") {
    return sqlQuoteString(String(obj.v ?? ""), engine);
  }

  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  if (typeof cell === "number" && Number.isFinite(cell)) return String(cell);

  if (cell == null) return "NULL";
  return sqlQuoteString(String(cell), engine);
}

export function formatSqlInsertChunk(args: {
  engine: string;
  schema: string;
  tableName: string;
  columnNames: string[];
  columnTypes?: string[];
  rows: unknown[][];
  qIdent: (name: string, engine?: any) => string;
}): string {
  const {
    engine,
    schema,
    tableName,
    columnNames,
    columnTypes = [],
    rows,
    qIdent,
  } = args;
  if (!rows.length) return "";

  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;
  const colList = columnNames.map((c) => qIdent(c, engine)).join(", ");
  const values = rows
    .map((row) => {
      const cells = row.map((cell, i) =>
        formatSqlInsertValue(cell, {
          dbType: columnTypes[i] ?? "",
          engine,
        })
      );
      return `  (${cells.join(", ")})`;
    })
    .join(",\n");

  return `INSERT INTO ${tableIdent} (${colList}) VALUES\n${values};\n`;
}
