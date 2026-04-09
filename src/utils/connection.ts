import type { ConnectionProfile } from "src/lib/tauri";

export function safeLower(v?: string | null) {
  return (v ?? "").toLowerCase();
}

function sortConnectionsByNewest(
  connections: ConnectionProfile[]
): ConnectionProfile[] {
  return connections
    .slice()
    .sort((a, b) => {
      const byCreated = (b.created_at ?? 0) - (a.created_at ?? 0);
      if (byCreated !== 0) return byCreated;
      const byUpdated = (b.updated_at ?? 0) - (a.updated_at ?? 0);
      if (byUpdated !== 0) return byUpdated;
      return safeLower(a.label).localeCompare(safeLower(b.label));
    });
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

  if (engine === "sqlite") {
    const sqlite = conn.input?.sqlite;
    return {
      host: "",
      database: sqlite?.path ?? "",
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
  searchQuery: string
) {
  const q = safeLower(searchQuery.trim());
  if (!q) return sortConnectionsByNewest(connections);

  return sortConnectionsByNewest(
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
    })
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
      connections: sortConnectionsByNewest(conns),
    }))
    .sort((a, b) => safeLower(a.tag).localeCompare(safeLower(b.tag)));
}
