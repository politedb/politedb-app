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
 *
 * Always an array literal ('{…}') whose type comes from the destination
 * column (INSERT target, SET column, WHERE comparison), never a cast: the
 * reported type name has no schema and is lowercased by some callers, so
 * a cast could name another type (an enum "Text" in another schema is not
 * text). Nested JSON arrays become multidimensional literals.
 */
export function pgArrayValueSql(
  jsonText: string,
  quote: (text: string) => string
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return quote(`{${parsed.map(arrayLiteralElement).join(",")}}`);
}
