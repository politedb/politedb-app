// types.ts (FE)
export type CellValue =
  | { t: "Null" }
  | { t: "Str"; v: string }
  | { t: "Json"; v: string }
  | { t: "I64"; v: number }
  | { t: "F64"; v: number }
  | { t: "Bool"; v: boolean }
  | { t: "BytesB64"; v: string };

// utils
export function cellToString(cell: any): string {
  if (cell == null) return "";

  if (
    typeof cell === "string" ||
    typeof cell === "number" ||
    typeof cell === "boolean"
  ) {
    return String(cell);
  }

  if (typeof cell === "object") {
    // { t: "Str", v: "public" }
    if ("v" in cell) return String((cell as any).v ?? "");
    // { t: "Null" }
    if ((cell as any).t === "Null") return "";
  }

  return "";
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

export function formatBytesSize(bytes: string | number): string {
  const numBytes = typeof bytes === "string" ? parseFloat(bytes) : bytes;

  if (!Number.isFinite(numBytes) || numBytes < 0) {
    return "0 B";
  }

  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (numBytes >= GB) {
    return `${numBytes / GB} GB`;
  } else if (numBytes >= MB) {
    return `${numBytes / MB} MB`;
  } else if (numBytes >= KB) {
    return `${numBytes / KB} KB`;
  } else {
    return `${numBytes} B`;
  }
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
    sqlite: "SQLite",
    redis: "Redis",
  };

  const pretty = map[v] ?? String(engine ?? "Postgres");

  return opts?.upper ? pretty.toUpperCase() : pretty;
}
