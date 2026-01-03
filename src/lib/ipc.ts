import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type SecretRef =
  | { kind: "inline"; value: string }
  | { kind: "keychain"; value: string };

export type PgConnectInput = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: SecretRef;
  ssl_mode?: string | null;
  connect_timeout_ms?: number | null;
  statement_timeout_ms?: number | null;
  ssl_key_path?: string | null;
  ssl_cert_path?: string | null;
  ssl_ca_path?: string | null;
};

export type ConnectionCreateInput = {
  engine: "postgres";
  label: string;
  postgres: PgConnectInput;
};

export async function secretsSet(key: string, secret: string): Promise<void> {
  // 🔁 Đổi đúng tên command theo backend của bạn
  //   await invoke("secrets_set", { key, secret });
}

export async function connectionTest(
  input: ConnectionCreateInput
): Promise<void> {
  console.log({ input });
  await invoke("connection_create", { input });
}

export async function connectionCreate(input: ConnectionCreateInput) {
  const res = await invoke<any>("connection_create", { input });
  console.log("connection_create result:", res);
  return res;
}

export async function operationExecute(input: any): Promise<string> {
  return invoke<string>("operation_execute", { input });
}

export type ConnectionInfo = { id: string; engine: string; label: string };

export async function runQuery(
  connectionId: string,
  sql: string
): Promise<string> {
  return invoke<string>("operation_execute", {
    input: {
      connection_id: connectionId,
      kind: "sql_query",
      sql: { sql, batch_size: 500, max_rows: 50_000 },
    },
  });
}

export async function cancelQuery(opId: string) {
  await invoke("operation_cancel", { op_id: opId });
}

export function listenOp(
  opId: string,
  onChunk: (chunk: any) => void,
  onDone: (done: any) => void,
  onError: (err: any) => void
): UnlistenFn {
  const unsubs: UnlistenFn[] = [];

  Promise.all([
    listen("op:chunk_table", (e) => {
      const p: any = e.payload;
      if (p?.op_id === opId) onChunk(p);
    }),
    listen("op:done", (e) => {
      const p: any = e.payload;
      if (p?.op_id === opId) onDone(p);
    }),
    listen("op:error", (e) => {
      const p: any = e.payload;
      if (p?.op_id === opId) onError(p);
    }),
  ]).then((fns) => unsubs.push(...fns));

  return () => unsubs.forEach((u) => u());
}
