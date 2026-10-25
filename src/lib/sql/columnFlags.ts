/**
 * Whether a column allows NULL, from any of the ways the app writes it:
 * catalog YES/NO, editor true/false, new-table NULL/NOT NULL, or a real
 * boolean. Undefined when it says neither (an empty cell).
 */
export function parseNullable(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value == null) return undefined;
  const text = String(value).trim().toUpperCase();
  if (["YES", "Y", "TRUE", "T", "1", "NULL"].includes(text)) return true;
  if (["NO", "N", "FALSE", "F", "0", "NOT NULL"].includes(text)) return false;
  return undefined;
}

/** How a nullable flag shows in the structure editor: YES, NO or blank. */
export function nullableLabel(value: unknown): string {
  const nullable = parseNullable(value);
  return nullable === undefined ? "" : nullable ? "YES" : "NO";
}
