// types.ts (FE)
import { isDefaultCellEditValue } from "src/lib/table-data/cellEditValue";

export type CellValue =
  | { t: "Null" }
  | { t: "Str"; v: string }
  | { t: "Json"; v: string }
  | { t: "I64"; v: number }
  | { t: "F64"; v: number }
  | { t: "Bool"; v: boolean }
  | { t: "BytesB64"; v: string };

// utils
export function decodeBytesB64(b64: string): Uint8Array | null {
  try {
    if (!b64) return new Uint8Array();

    // Browser-safe base64 decode
    const atobFn = globalThis.atob;
    if (typeof atobFn !== "function") return null;

    const bin = atobFn(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeBytesB64ToUtf8(b64: string): string {
  const bytes = decodeBytesB64(b64);
  if (!bytes) return b64;

  try {
    if (typeof TextDecoder === "function") {
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }

    // Fallback: latin1-style string
    return String.fromCharCode(...bytes);
  } catch {
    // Keep original encoded value if decode fails
    return b64;
  }
}

export function formatBytesB64AsHex(b64: string): string {
  const bytes = decodeBytesB64(b64);
  if (!bytes) return b64;

  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0").toUpperCase()
  ).join("");
}

export function cellToBinaryHexString(
  cell: any,
  allowNull: boolean = false
): string | null {
  if (cell && typeof cell === "object" && cell.t === "BytesB64") {
    return formatBytesB64AsHex(String(cell.v ?? ""));
  }
  return cellToString(cell, allowNull);
}

export function cellToString(
  cell: any,
  allowNull: boolean = false
): string | null {
  if (cell == null) return allowNull ? null : "";

  if (
    typeof cell === "string" ||
    typeof cell === "number" ||
    typeof cell === "boolean"
  ) {
    return String(cell);
  }

  if (typeof cell === "object") {
    if (isDefaultCellEditValue(cell)) return "DEFAULT";
    // { t: "Null" }
    if ((cell as any).t === "Null") return allowNull ? null : "";
    // { t: "BytesB64", v: "..." } -> decode for display/use
    if ((cell as any).t === "BytesB64") {
      return decodeBytesB64ToUtf8(String((cell as any).v ?? ""));
    }
    // { t: "Str", v: "public" } and other scalar wrappers
    if ("v" in cell) return String((cell as any).v ?? "");
  }

  return "";
}

export function cellEditValuesEqual(left: unknown, right: unknown): boolean {
  const leftIsDefault = isDefaultCellEditValue(left);
  const rightIsDefault = isDefaultCellEditValue(right);
  if (leftIsDefault || rightIsDefault) {
    return leftIsDefault && rightIsDefault;
  }

  return cellToString(left, true) === cellToString(right, true);
}

export function toNumber(v: any, fallback: number) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function hexToRgba(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function formatBytesSize(
  bytes: string | number,
  options?: { fractionDigits?: number }
): string {
  const numBytes = typeof bytes === "string" ? parseFloat(bytes) : bytes;
  const fractionDigits = Math.max(0, options?.fractionDigits ?? 0);

  if (!Number.isFinite(numBytes) || numBytes < 0) {
    return fractionDigits > 0 ? `0.${"0".repeat(fractionDigits)} B` : "0 B";
  }

  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const formatDecimal = (value: number) => value.toFixed(fractionDigits);

  if (numBytes >= GB) {
    return `${formatDecimal(numBytes / GB)} GB`;
  } else if (numBytes >= MB) {
    return `${formatDecimal(numBytes / MB)} MB`;
  } else if (numBytes >= KB) {
    return `${formatDecimal(numBytes / KB)} KB`;
  } else {
    return fractionDigits > 0
      ? `${numBytes.toFixed(fractionDigits)} B`
      : `${numBytes} Bytes`;
  }
}

export function normalizeByteSizeLabel(value?: string | number): string {
  if (value === undefined || value === "") return "--";
  if (typeof value === "number") return formatBytesSize(value);
  const trimmed = value.trim();
  const rawBytes = trimmed.match(/^(\d+(?:\.\d+)?)(?:\s*(?:bytes?|b))?$/i);
  return rawBytes ? formatBytesSize(Number(rawBytes[1])) : trimmed;
}

export function normalizeTag(s: string) {
  return s
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .toLowerCase();
}

export function normalizeTags(
  raw: string | string[] | null | undefined
): string[] {
  const arr: string[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? [raw]
      : [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of arr) {
    const normalized = normalizeTag(item);
    if (!normalized) continue;

    if (seen.has(normalized)) continue;
    seen.add(normalized);

    out.push(normalized);
  }

  return out;
}

export function normalizeEngineName(
  engine: unknown,
  opts?: { upper?: boolean }
): string {
  const v = String(engine ?? "").toLowerCase();

  const map: Record<string, string> = {
    postgres: "Postgres",
    postgresql: "Postgres",
    mysql: "MySQL",
    mariadb: "MariaDB",
    mongo: "MongoDB",
    sqlite: "SQLite",
    oracle: "Oracle",
    snowflake: "Snowflake",
    duckdb: "DuckDB",
    sqlserver: "SQL Server",
    redis: "Redis",
  };

  const pretty = map[v] ?? String(engine ?? "Postgres");

  return opts?.upper ? pretty.toUpperCase() : pretty;
}

function extractSemverLike(value: string, parts: number = 2): string {
  const match = value.match(/\d+(?:\.\d+)+/);
  if (!match) return "";
  return match[0].split(".").slice(0, parts).join(".");
}

export function formatDatabaseVersion(
  engine: unknown,
  version: unknown
): string {
  const raw = String(version ?? "").trim();
  if (!raw) return "";

  const normalizedEngine = String(engine ?? "").toLowerCase();

  if (normalizedEngine === "sqlserver") {
    const year = raw.match(/\b20\d{2}\b/);
    if (year) return year[0];

    const semver = extractSemverLike(raw, 2);
    return semver || raw;
  }

  if (
    [
      "postgres",
      "postgresql",
      "mysql",
      "mariadb",
      "mongo",
      "sqlite",
      "oracle",
      "snowflake",
      "redis",
    ].includes(normalizedEngine)
  ) {
    const semver = extractSemverLike(raw, 2);
    return semver || raw;
  }

  const generic = extractSemverLike(raw, 2);
  return generic || raw;
}

export function formatDateTime(
  value?: number | string | null,
  includeTime?: boolean
) {
  if (!value) return "";
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: includeTime ? "medium" : undefined,
  }).format(date);
}

export function formatDaysUntil(value?: number | string | null) {
  if (!value) return 0;
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return 0;
  return Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}
