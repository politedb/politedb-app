import type { ConnectionProfile } from "src/lib/tauri";
import { formatConnectionDatabaseDisplay } from "./connection";

function firstNonEmpty(...xs: Array<string | undefined | null>) {
  for (const x of xs) {
    const v = (x ?? "").trim();
    if (v) return v;
  }
  return "";
}

function formatConnectionTarget(
  profile: ConnectionProfile,
  engine: string,
  host?: string,
  port?: number
) {
  switch (engine) {
    case "d1":
      return profile.input?.d1?.account_id?.trim() ?? "";
    case "turso":
      return profile.input?.turso?.url?.trim() ?? "";
    case "snowflake":
      return profile.input?.snowflake?.account?.trim() ?? "";
    case "google_sheets":
      return "";
    default:
      return host ? `${host}${port != null ? `:${port}` : ""}` : "";
  }
}

type EngineInput =
  | ConnectionProfile["input"]["postgres"]
  | ConnectionProfile["input"]["mysql"]
  | ConnectionProfile["input"]["sqlserver"]
  | ConnectionProfile["input"]["sqlite"]
  | ConnectionProfile["input"]["d1"]
  | ConnectionProfile["input"]["turso"]
  | ConnectionProfile["input"]["oracle"]
  | ConnectionProfile["input"]["mongo"]
  | ConnectionProfile["input"]["cassandra"]
  | ConnectionProfile["input"]["redis"]
  | ConnectionProfile["input"]["snowflake"]
  | ConnectionProfile["input"]["duckdb"]
  | ConnectionProfile["input"]["clickhouse"]
  | ConnectionProfile["input"]["google_sheets"];

function getEngineInput(profile: ConnectionProfile): {
  engine: string;
  input: EngineInput | undefined;
} {
  const engine = String(profile.engine || profile.input?.engine || "");
  if (engine === "postgres") {
    return { engine, input: profile.input?.postgres };
  }
  if (engine === "mysql" || engine === "mariadb") {
    return { engine, input: profile.input?.mysql };
  }
  if (engine === "sqlserver") {
    return { engine, input: profile.input?.sqlserver };
  }
  if (engine === "mongo") {
    return { engine, input: profile.input?.mongo };
  }
  if (engine === "cassandra") {
    return { engine, input: profile.input?.cassandra };
  }
  if (engine === "sqlite") {
    return { engine, input: profile.input?.sqlite };
  }
  if (engine === "d1") {
    return { engine, input: profile.input?.d1 };
  }
  if (engine === "turso") {
    return { engine, input: profile.input?.turso };
  }
  if (engine === "oracle") {
    return { engine, input: profile.input?.oracle };
  }
  if (engine === "snowflake") {
    return { engine, input: profile.input?.snowflake };
  }
  if (engine === "duckdb") {
    return { engine, input: profile.input?.duckdb };
  }
  if (engine === "redis") {
    return { engine, input: profile.input?.redis };
  }
  if (engine === "clickhouse") {
    return { engine, input: profile.input?.clickhouse };
  }
  if (engine === "google_sheets") {
    return { engine, input: profile.input?.google_sheets };
  }
  return { engine, input: undefined };
}

/**
 * One-line summary of where a connection points: `host:port • database` (or the
 * account, URL or file name for engines without a host), plus whether it uses SSH.
 */
export function connectionProfileSummary(profile: ConnectionProfile) {
  const { engine, input } = getEngineInput(profile);

  const host =
    input && "host" in input ? (input.host as string | undefined) : undefined;
  const port =
    input && "port" in input ? (input.port as number | undefined) : undefined;

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
    case "sqlite":
      database = profile.input?.sqlite?.path ?? "";
      break;
    case "d1":
      database = profile.input?.d1?.database_id ?? "";
      break;
    case "turso":
      database = "";
      break;
    case "oracle":
      database = profile.input?.oracle?.database ?? "";
      break;
    case "snowflake":
      database = profile.input?.snowflake?.database ?? "";
      break;
    case "duckdb":
      database = profile.input?.duckdb?.path ?? "";
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
    case "clickhouse":
      database = profile.input?.clickhouse?.database ?? "";
      break;
    case "google_sheets":
      database = profile.input?.google_sheets?.spreadsheet_id ?? "";
      break;
  }

  const hostPort = formatConnectionTarget(profile, engine, host, port);
  const databaseLabel = formatConnectionDatabaseDisplay(database, engine);
  const subtitle = firstNonEmpty(
    hostPort && databaseLabel ? `${hostPort} • ${databaseLabel}` : hostPort,
    databaseLabel
  );

  return { engine, subtitle, hasSsh: !!profile.input?.ssh };
}
