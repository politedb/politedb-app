import type { ConnectionCreateInput, ConnectionProfile } from "src/lib/tauri";
import type { ConnectionSortMode, DatabaseEngine } from "src/types";

export function safeLower(v?: string | null) {
  return (v ?? "").toLowerCase();
}

export function sortConnections(
  connections: ConnectionProfile[],
  mode: ConnectionSortMode = "created-desc"
): ConnectionProfile[] {
  return connections.slice().sort((a, b) => {
    if (mode === "label-asc") {
      const byLabel = safeLower(a.label).localeCompare(safeLower(b.label));
      if (byLabel !== 0) return byLabel;
    }
    if (mode === "label-desc") {
      const byLabel = safeLower(b.label).localeCompare(safeLower(a.label));
      if (byLabel !== 0) return byLabel;
    }
    if (mode === "created-asc") {
      const byCreated = (a.created_at ?? 0) - (b.created_at ?? 0);
      if (byCreated !== 0) return byCreated;
      const byUpdated = (a.updated_at ?? 0) - (b.updated_at ?? 0);
      if (byUpdated !== 0) return byUpdated;
    }
    if (mode === "created-desc") {
      const byCreated = (b.created_at ?? 0) - (a.created_at ?? 0);
      if (byCreated !== 0) return byCreated;
      const byUpdated = (b.updated_at ?? 0) - (a.updated_at ?? 0);
      if (byUpdated !== 0) return byUpdated;
    }
    return safeLower(a.label).localeCompare(safeLower(b.label));
  });
}

/** UI label for database/path — sqlite & duckdb show file name only. */
export function formatConnectionDatabaseDisplay(
  database: string,
  engine?: string | null
): string {
  const db = database.trim();
  if (!db) return "";
  if (engine === "sqlite" || engine === "duckdb") {
    const normalized = db.replace(/\\/g, "/").replace(/\/+$/g, "");
    const slash = normalized.lastIndexOf("/");
    return slash >= 0 ? normalized.slice(slash + 1) : normalized;
  }
  return db;
}

/** Turso has no database in the profile — breadcrumb shows schema (main) or active table. */
export function usesTableOnlyBreadcrumb(
  engine?: DatabaseEngine | string | null
): boolean {
  return engine === "turso";
}

/** Active database/keyspace from the connection profile (for sidebar when no SQL schemas). */
export function currentDatabaseFromInput(
  engine?: DatabaseEngine,
  input?: ConnectionCreateInput | null
): string {
  if (!engine || !input) return "";
  switch (engine) {
    case "postgres":
      return input.postgres?.database?.trim() ?? "";
    case "mysql":
    case "mariadb":
      return input.mysql?.database?.trim() ?? "";
    case "sqlserver":
      return input.sqlserver?.database?.trim() ?? "";
    case "mongo":
      return input.mongo?.database?.trim() ?? "";
    case "cassandra":
      return input.cassandra?.keyspace?.trim() ?? "";
    case "clickhouse":
      return input.clickhouse?.database?.trim() ?? "";
    case "snowflake":
      return input.snowflake?.database?.trim() ?? "";
    case "oracle":
      return input.oracle?.database?.trim() ?? "";
    default:
      return "";
  }
}

export function pickHostDbUser(conn: ConnectionProfile) {
  const engine = conn.engine;

  if (engine === "postgres") {
    const pg = conn.input?.postgres;
    return {
      host: pg?.host ?? "",
      database: pg?.database ?? "",
      user: pg?.user ?? "",
    };
  }

  if (engine === "mysql" || engine === "mariadb") {
    const my = conn.input?.mysql;
    return {
      host: my?.host ?? "",
      database: my?.database ?? "",
      user: my?.user ?? "",
    };
  }

  if (engine === "sqlserver") {
    const ss = conn.input?.sqlserver;
    return {
      host: ss?.host ?? "",
      database: ss?.database ?? "",
      user: ss?.user ?? "",
    };
  }

  if (engine === "mongo") {
    const mongo = conn.input?.mongo;
    return {
      host: mongo?.host ?? "",
      database: mongo?.database ?? "",
      user: mongo?.user ?? "",
    };
  }

  if (engine === "cassandra") {
    const cassandra = conn.input?.cassandra;
    return {
      host: cassandra?.host ?? "",
      database: cassandra?.keyspace ?? "",
      user: cassandra?.user ?? "",
    };
  }

  if (engine === "sqlite") {
    const sqlite = conn.input?.sqlite;
    return {
      host: "",
      database: sqlite?.path ?? "",
      user: "",
    };
  }

  if (engine === "duckdb") {
    const duckdb = conn.input?.duckdb;
    return {
      host: "",
      database: duckdb?.path ?? "",
      user: "",
    };
  }

  if (engine === "d1") {
    const d1 = conn.input?.d1;
    return {
      host: d1?.account_id ?? "",
      database: d1?.database_id ?? "",
      user: "",
    };
  }

  if (engine === "turso") {
    const turso = conn.input?.turso;
    return {
      host: turso?.url ?? "",
      database: "",
      user: "",
    };
  }

  if (engine === "oracle") {
    const oc = conn.input?.oracle;
    return {
      host: oc?.host ?? "",
      database: oc?.database ?? "",
      user: oc?.user ?? "",
    };
  }

  if (engine === "snowflake") {
    const sf = conn.input?.snowflake;
    return {
      host: sf?.account ?? "",
      database: sf?.database ?? "",
      user: sf?.user ?? "",
    };
  }

  if (engine === "clickhouse") {
    const ch = conn.input?.clickhouse;
    return {
      host: ch?.host ?? "",
      database: ch?.database ?? "",
      user: ch?.user ?? "",
    };
  }

  if (engine === "redis") {
    const rd = conn.input?.redis;
    return {
      host: rd?.host ?? "",
      database: `db ${rd?.db ?? 0}`,
      user: rd?.user ?? "",
    };
  }

  return { host: "", database: "", user: "" };
}

export function filterConnections(
  connections: ConnectionProfile[],
  searchQuery: string,
  sortMode: ConnectionSortMode = "created-desc"
) {
  const q = safeLower(searchQuery.trim());
  if (!q) return sortConnections(connections, sortMode);

  return sortConnections(
    connections.filter((conn) => {
      const label = safeLower(conn.label);
      const engine = safeLower(conn.engine);

      const { host, database, user } = pickHostDbUser(conn);
      const hostL = safeLower(host);
      const dbL = safeLower(database);
      const userL = safeLower(user);
      const userHost = `${userL}@${hostL}`;
      const tags = Array.isArray(conn.input?.tags) ? conn.input.tags : [];
      const tagsL = tags.map((tag) => safeLower(tag)).join(" ");

      return (
        label.includes(q) ||
        engine.includes(q) ||
        hostL.includes(q) ||
        dbL.includes(q) ||
        tagsL.includes(q) ||
        userHost.includes(q)
      );
    }),
    sortMode
  );
}

export function groupConnections(connections: ConnectionProfile[]) {
  const grouped = new Map<string, ConnectionProfile[]>();

  for (const conn of connections) {
    const tags = Array.isArray(conn.input?.tags) ? conn.input.tags : [];
    const normalizedTags = tags.length ? tags : ["local"];

    for (const tag of normalizedTags) {
      const safeTag = String(tag ?? "").trim() || "local";
      const bucket = grouped.get(safeTag) ?? [];
      bucket.push(conn);
      grouped.set(safeTag, bucket);
    }
  }

  return Array.from(grouped.entries())
    .map(([tag, conns]) => ({
      tag,
      connections: sortConnections(conns, "created-desc"),
    }))
    .sort((a, b) => safeLower(a.tag).localeCompare(safeLower(b.tag)));
}
