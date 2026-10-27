/**
 * PostgreSQL array values as SQL, from the JSON array text PoliteDB holds
 * them in (CellValue::Json). Shared by backups and table edits.
 */

export function isPostgresArrayType(dbType: string | undefined): boolean {
  const t = (dbType ?? "").toLowerCase().trim();
  if (!t) return false;
  return t.startsWith("_") || t.endsWith("[]");
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
 * Built-in element types (pg_catalog, always on the search path): their
 * arrays are written ARRAY[…]::type[]. Any other type (an enum, a domain,
 * an extension type) may be in another schema or need quoting, which the
 * reported name does not say, so its arrays are written as an array
 * literal whose type comes from the destination column.
 */
const BUILTIN_ELEMENT_TYPES = new Set([
  "bool",
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "money",
  "oid",
  "text",
  "varchar",
  "bpchar",
  "char",
  "name",
  "uuid",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "interval",
  "json",
  "jsonb",
  "bytea",
  "inet",
  "cidr",
  "macaddr",
  "macaddr8",
  "bit",
  "varbit",
  "xml",
]);

/** An element of a PostgreSQL array literal ({…} text). */
function arrayLiteralElement(item: unknown): string {
  if (item === null || item === undefined) return "NULL";
  if (Array.isArray(item))
    return `{${item.map(arrayLiteralElement).join(",")}}`;
  const text =
    typeof item === "string"
      ? item
      : typeof item === "number" || typeof item === "boolean"
        ? String(item)
        : JSON.stringify(item);
  // Always double-quoted: NULL, commas, braces and spaces stay data.
  return `"${text.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/**
 * SQL for a PostgreSQL array value given as JSON array text, or null when
 * the text is not a JSON array (the caller keeps its own handling).
 * `quote` writes an SQL string literal the caller's way.
 */
export function pgArrayValueSql(
  jsonText: string,
  dbType: string,
  quote: (text: string) => string
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const cast = pgArrayCastType(dbType);
  const element = cast.slice(0, -2);
  if (!BUILTIN_ELEMENT_TYPES.has(element)) {
    return quote(`{${parsed.map(arrayLiteralElement).join(",")}}`);
  }

  const elems = parsed.map((item) => {
    if (item === null) return "NULL";
    if (typeof item === "boolean") return item ? "TRUE" : "FALSE";
    if (typeof item === "number" && Number.isFinite(item)) return String(item);
    if (typeof item === "string") return quote(item);
    return quote(JSON.stringify(item));
  });
  return `ARRAY[${elems.join(", ")}]::${cast}`;
}
