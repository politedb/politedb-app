/** Strip ClickHouse wrappers like Nullable(...) / LowCardinality(...). */
export function unwrapClickhouseType(typeName: string): string {
  let t = typeName.trim();
  for (let i = 0; i < 8; i++) {
    const nullable = t.match(/^nullable\s*\((.+)\)$/i);
    if (nullable) {
      t = nullable[1].trim();
      continue;
    }
    const lowCardinality = t.match(/^lowcardinality\s*\((.+)\)$/i);
    if (lowCardinality) {
      t = lowCardinality[1].trim();
      continue;
    }
    break;
  }
  return t;
}

/** Fractional digits from `Decimal(P, S)` / `Decimal64(S)` (after unwrap). */
export function clickhouseDecimalScale(
  dbType: string | undefined
): number | null {
  if (!dbType) return null;
  const inner = unwrapClickhouseType(dbType).toLowerCase();
  if (!inner.startsWith("decimal") && !inner.startsWith("fixedpoint")) {
    return null;
  }
  const twoArg = inner.match(/\(\s*\d+\s*,\s*(\d+)\s*\)/);
  if (twoArg) {
    const scale = Number(twoArg[1]);
    return Number.isFinite(scale) ? scale : null;
  }
  const oneArg = inner.match(/decimal(?:32|64|128|256)?\s*\(\s*(\d+)\s*\)/);
  if (oneArg) {
    const scale = Number(oneArg[1]);
    return Number.isFinite(scale) ? scale : null;
  }
  return null;
}

/** Human-readable decimal literal for ClickHouse SQL (not the scaled Int storage). */
export function formatClickhouseDecimalForSql(
  value: number,
  scale: number
): string {
  if (!Number.isFinite(value)) return String(value);
  if (scale <= 0) return String(value);
  return value.toFixed(scale);
}

/** Build a canonical Decimal type string when information_schema only gives scale separately. */
export function normalizeClickhouseDbType(
  dataType: string | null | undefined,
  numericScale: string | null | undefined
): string {
  const dt = (dataType ?? "").trim();
  if (!dt) return dt;
  const scale = Number(numericScale);
  if (!Number.isFinite(scale) || scale < 0) return dt;
  const inner = unwrapClickhouseType(dt).toLowerCase();
  if (!inner.startsWith("decimal")) return dt;
  if (inner.includes(",")) return dt;
  const oneArg = unwrapClickhouseType(dt).match(
    /^(decimal(?:32|64|128|256)?)\s*\(\s*(\d+)\s*\)/i
  );
  if (oneArg) {
    return `${oneArg[1]}(${oneArg[2]}, ${scale})`;
  }
  if (clickhouseDecimalScale(dt) !== null) return dt;
  return `Decimal(18, ${scale})`;
}
