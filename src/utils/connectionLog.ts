import type { ConnectionProfile } from "src/lib/tauri";
import { licenseDeviceInfo } from "src/lib/tauri/license";
import type { ConnectionOpenLogEntry } from "src/types";

let cachedDeviceName: string | null = null;

export async function getLogDeviceName(): Promise<string> {
  if (cachedDeviceName) return cachedDeviceName;
  try {
    const info = await licenseDeviceInfo();
    cachedDeviceName = info.device_name?.trim() || "This device";
  } catch {
    cachedDeviceName = "This device";
  }
  return cachedDeviceName;
}

function firstNonEmpty(...xs: Array<string | undefined | null>) {
  for (const x of xs) {
    const v = (x ?? "").trim();
    if (v) return v;
  }
  return "";
}

function getEngineInput(profile: ConnectionProfile) {
  const engine = String(profile.engine || profile.input?.engine || "");
  const input = profile.input as Record<string, unknown> | undefined;
  if (engine === "postgres") return profile.input?.postgres;
  if (engine === "mysql" || engine === "mariadb") return profile.input?.mysql;
  if (engine === "sqlserver") return profile.input?.sqlserver;
  if (engine === "mongo") return profile.input?.mongo;
  if (engine === "cassandra") return profile.input?.cassandra;
  if (engine === "sqlite") return profile.input?.sqlite;
  if (engine === "d1") return profile.input?.d1;
  if (engine === "turso") return profile.input?.turso;
  if (engine === "oracle") return profile.input?.oracle;
  if (engine === "redis") return profile.input?.redis;
  void input;
  return undefined;
}

export function profileConnectionHost(profile: ConnectionProfile): string {
  const engine = String(profile.engine || profile.input?.engine || "");
  const input = getEngineInput(profile) as
    | {
        host?: string;
        port?: number;
        path?: string;
        database?: string;
        db?: number | null;
      }
    | undefined;

  if (engine === "sqlite") {
    return firstNonEmpty(input?.path, profile.label);
  }
  if (engine === "d1") {
    const d1 = profile.input?.d1;
    return firstNonEmpty(d1?.database_id, d1?.account_id, profile.label);
  }

  if (engine === "turso") {
    const turso = profile.input?.turso;
    return firstNonEmpty(turso?.url, profile.label);
  }

  const host = input?.host;
  const port = input?.port;
  const hostPort = host ? `${host}${port != null ? `:${port}` : ""}` : "";

  let database = "";
  switch (engine) {
    case "postgres":
      database = profile.input?.postgres?.database ?? "";
      break;
    case "mysql":
    case "mariadb":
      database = profile.input?.mysql?.database ?? "";
      break;
    case "sqlserver":
      database = profile.input?.sqlserver?.database ?? "";
      break;
    case "oracle":
      database = profile.input?.oracle?.database ?? "";
      break;
    case "mongo":
      database = profile.input?.mongo?.database ?? "";
      break;
    case "cassandra":
      database = profile.input?.cassandra?.keyspace ?? "";
      break;
    case "redis":
      database =
        profile.input?.redis?.db != null ? `db ${profile.input.redis.db}` : "";
      break;
  }

  return firstNonEmpty(
    hostPort && database ? `${hostPort} • ${database}` : hostPort,
    database,
    profile.label
  );
}

export function profileDbUser(profile: ConnectionProfile): string | undefined {
  const engine = String(profile.engine || profile.input?.engine || "");
  switch (engine) {
    case "postgres":
      return profile.input?.postgres?.user?.trim() || undefined;
    case "mysql":
    case "mariadb":
      return profile.input?.mysql?.user?.trim() || undefined;
    case "sqlserver":
      return profile.input?.sqlserver?.user?.trim() || undefined;
    case "oracle":
      return profile.input?.oracle?.user?.trim() || undefined;
    case "mongo":
      return profile.input?.mongo?.user?.trim() || undefined;
    case "cassandra":
      return profile.input?.cassandra?.user?.trim() || undefined;
    case "redis":
      return profile.input?.redis?.user?.trim() || undefined;
    default:
      return undefined;
  }
}

/** "open" while the session is still running; "success" once it closed. */
export type ConnectionLogDisplayStatus = "open" | "success" | "failed";

export function connectionLogDisplayStatus(
  status: ConnectionOpenLogEntry["status"]
): ConnectionLogDisplayStatus {
  if (status === "failed") return "failed";
  return status === "active" ? "open" : "success";
}

export function filterConnectionLogEntries(
  entries: ConnectionOpenLogEntry[],
  query: string
): ConnectionOpenLogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;

  return entries.filter((entry) => {
    const haystack = [
      entry.profileLabel,
      entry.host,
      entry.dbUser,
      entry.deviceName,
      entry.engine,
      entry.error,
      connectionLogDisplayStatus(entry.status),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/* -------------------------------------------------------------------------- */
/* History page                                                               */
/* -------------------------------------------------------------------------- */

const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const dayWithYearFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Start time of a session, e.g. "10:38". */
export function formatSessionTime(openedAt: number): string {
  return timeFmt.format(new Date(openedAt));
}

/** How long a session lasted (or has lasted so far): "< 1 min", "3 min", "1 h 5 min". */
export function formatSessionDuration(
  openedAt: number,
  closedAt: number | undefined,
  now: number
): string {
  const minutes = Math.floor(
    Math.max(0, (closedAt ?? now) - openedAt) / 60_000
  );
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
}

function startOfDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Heading for the day a session started: "Today", "Yesterday", "Mon, Oct 19". */
export function sessionDayLabel(openedAt: number, now: number): string {
  const day = startOfDay(openedAt);
  const today = startOfDay(now);
  if (day === today) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return "Yesterday";
  const date = new Date(openedAt);
  return date.getFullYear() === new Date(now).getFullYear()
    ? dayFmt.format(date)
    : dayWithYearFmt.format(date);
}

/** One table row: a session, or a run of identical short sessions folded together. */
export type ConnectionLogRow = {
  entry: ConnectionOpenLogEntry;
  /** Sessions folded into this row (1 for a single session). */
  count: number;
};

const SHORT_SESSION_MS = 60_000;

function isShortFinished(entry: ConnectionOpenLogEntry) {
  return (
    entry.status !== "active" &&
    entry.closedAt != null &&
    entry.closedAt - entry.openedAt < SHORT_SESSION_MS
  );
}

/**
 * Folds back-to-back short sessions (under a minute) of the same connection,
 * with the same outcome and error, on the same day, into one row with a count.
 * Expects entries newest first; the row shows the newest session.
 */
export function collapseRepeatedSessions(
  entries: readonly ConnectionOpenLogEntry[]
): ConnectionLogRow[] {
  const rows: ConnectionLogRow[] = [];
  for (const entry of entries) {
    const last = rows[rows.length - 1];
    if (
      last &&
      isShortFinished(entry) &&
      isShortFinished(last.entry) &&
      last.entry.profileId === entry.profileId &&
      last.entry.status === entry.status &&
      (last.entry.error ?? "") === (entry.error ?? "") &&
      startOfDay(last.entry.openedAt) === startOfDay(entry.openedAt)
    ) {
      last.count += 1;
      continue;
    }
    rows.push({ entry, count: 1 });
  }
  return rows;
}

export type ConnectionLogDay = {
  key: number;
  label: string;
  rows: ConnectionLogRow[];
};

/** Splits rows (newest first) into days, keeping their order. */
export function groupRowsByDay(
  rows: readonly ConnectionLogRow[],
  now: number
): ConnectionLogDay[] {
  const days: ConnectionLogDay[] = [];
  for (const row of rows) {
    const key = startOfDay(row.entry.openedAt);
    const last = days[days.length - 1];
    if (last?.key === key) last.rows.push(row);
    else
      days.push({
        key,
        label: sessionDayLabel(row.entry.openedAt, now),
        rows: [row],
      });
  }
  return days;
}

/** Shortens a long string in the middle: "politedb-e1d0…clickhouse.cloud:5432". */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  // Keep more of the end: the domain and port tell hosts apart.
  const head = Math.floor(keep * 0.4);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/**
 * Splits a logged target ("host:port • database") so the database is never cut
 * off: only the host part is shortened.
 */
export function splitSessionTarget(host: string): {
  address: string;
  database: string;
} {
  const at = host.lastIndexOf(" • ");
  return at < 0
    ? { address: host, database: "" }
    : { address: host.slice(0, at), database: host.slice(at + 3) };
}

export type ConnectionLogStatusFilter = "all" | "open" | "failed";

export function filterSessionsByStatus(
  entries: readonly ConnectionOpenLogEntry[],
  filter: ConnectionLogStatusFilter
): ConnectionOpenLogEntry[] {
  if (filter === "all") return [...entries];
  return entries.filter(
    (entry) => connectionLogDisplayStatus(entry.status) === filter
  );
}

/** Whether the log holds sessions from more than one device. */
export function hasSeveralDevices(
  entries: readonly ConnectionOpenLogEntry[]
): boolean {
  const first = entries[0]?.deviceName;
  return entries.some((entry) => entry.deviceName !== first);
}
