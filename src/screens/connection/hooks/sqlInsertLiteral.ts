/** SQL literal helpers for database backup INSERT statements. */

import {
  isPostgresArrayType,
  pgArrayCastType,
  pgArrayValueSql,
} from "src/lib/sql/pgArrayLiteral";

export { isPostgresArrayType, pgArrayCastType };

/**
 * Quote a string as an SQL literal.
 * Postgres: a value with a backslash is written as an E'…' string with the
 * backslashes doubled. Read either way — standard_conforming_strings on or
 * off, by the server or by the statement splitter — it is the same string
 * and ends at the same quote, so data can never end it early. Values
 * without a backslash stay plain '…' with `''` for a quote.
 * MySQL/MariaDB: escape both `\` and `'`.
 */
export function sqlQuoteString(value: string, engine?: string): string {
  const e = (engine ?? "").toLowerCase();
  if (e === "postgres" || e === "postgresql") {
    if (value.includes("\\")) {
      return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
    }
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export function isPostgresJsonType(dbType: string): boolean {
  const t = (dbType ?? "").toLowerCase().trim();
  return t === "json" || t === "jsonb";
}

/**
 * Convert a JSON array string (how PoliteDB stores PG arrays in CellValue::Json)
 * into SQL that Postgres accepts on restore: ARRAY[...]::elem[] for built-in
 * element types, an array literal typed by the column for others (enums).
 */
export function jsonArrayToPgArraySql(
  jsonText: string,
  dbType: string,
  engine = "postgres"
): string {
  const quote = (text: string) => sqlQuoteString(text, engine);
  return (
    pgArrayValueSql(jsonText, dbType, quote) ??
    `${quote(jsonText)}::${pgArrayCastType(dbType)}`
  );
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
