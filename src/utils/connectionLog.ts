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

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatConnectionLogDateRange(
  openedAt: number,
  closedAt?: number
): string {
  const start = new Date(openedAt);
  const startDate = dateFmt.format(start);
  const startTime = timeFmt.format(start);

  if (!closedAt) {
    return `${startDate}, ${startTime} - ${timeFmt.format(new Date())}`;
  }

  const end = new Date(closedAt);
  const endTime = timeFmt.format(end);

  if (start.toDateString() === end.toDateString()) {
    return `${startDate}, ${startTime} - ${endTime}`;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const dayDiff = Math.max(
    1,
    Math.floor((end.getTime() - start.getTime()) / dayMs)
  );
  return `${startDate}, ${startTime} - ${endTime} (+${dayDiff}d)`;
}

export type ConnectionLogDisplayStatus = "success" | "failed";

export function connectionLogDisplayStatus(
  status: ConnectionOpenLogEntry["status"]
): ConnectionLogDisplayStatus {
  return status === "failed" ? "failed" : "success";
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
