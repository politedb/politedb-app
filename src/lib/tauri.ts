import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export async function createPostgresConnection() {
  return invoke("connection_create", {
    input: {
      engine: "postgres",
      label: "Local Postgres",
      postgres: {
        host: "127.0.0.1",
        port: 5432,
        database: "postgres",
        user: "postgres",
        password: {
          kind: "inline",
          value: "postgres",
        },
      },
    },
  });
}

export async function runQuery(connectionId: string, sql: string) {
  return invoke<string>("operation_execute", {
    input: {
      connectionId,
      kind: "sql_query",
      sql: {
        sql,
        batchSize: 50,
        maxRows: 500,
      },
    },
  });
}

export async function cancelQuery(opId: string) {
  return invoke("operation_cancel", { opId });
}

export function listenQueryEvents(
  onChunk: (data: any) => void,
  onDone: (data: any) => void,
  onError: (data: any) => void
) {
  const unsubs: Array<() => void> = [];

  listen("op:chunk_table", (e) => onChunk(e.payload)).then((u) =>
    unsubs.push(u)
  );
  listen("op:done", (e) => onDone(e.payload)).then((u) => unsubs.push(u));
  listen("op:error", (e) => onError(e.payload)).then((u) => unsubs.push(u));

  return () => unsubs.forEach((u) => u());
}
