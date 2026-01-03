// src/components/PostgresConnectionDialog.tsx
import { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { connectionCreate, connectionTest } from "../lib/tauri/connection";
import { operationExecute } from "../lib/tauri/operation";
import { listenOp } from "../lib/tauri/events";
import { ConnectionCreateInput } from "../lib/tauri";

type InputEvt = JSX.TargetedEvent<HTMLInputElement>;
type SelectEvt = JSX.TargetedEvent<HTMLSelectElement>;

type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";
type TableItem = { schema: string; name: string };

const LIST_TABLES_SQL = `
select table_schema, table_name
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name;
`.trim();

function toNumber(v: string, fallback: number) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function cls(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function errText(e: any) {
  if (!e) return "UNKNOWN_ERROR";
  if (typeof e === "string") return e;
  if (e?.error) return String(e.error);
  if (e?.message) return String(e.message);
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function PostgresConnectionDialog() {
  const [name, setName] = useState("Mochi");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(5432);
  const [user, setUser] = useState("postgres");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("postgres");

  const [sslMode, setSslMode] = useState<SslMode>("prefer");

  const [busy, setBusy] = useState<null | "test" | "connect" | "tables">(null);
  const [msg, setMsg] = useState<string>("");
  const [connInfo, setConnInfo] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [tables, setTables] = useState<TableItem[]>([]);
  const [filter, setFilter] = useState("");

  function validate(): string | null {
    if (!name.trim()) return "Name is required.";
    if (!host.trim()) return "Host is required.";
    if (!Number.isFinite(port) || port <= 0 || port > 65535)
      return "Port is invalid.";
    if (!user.trim()) return "User is required.";
    if (!database.trim()) return "Database is required.";
    if (!password) return "Password is required.";
    return null;
  }

  const payload: ConnectionCreateInput = useMemo(
    () => ({
      engine: "postgres",
      label: name,
      postgres: {
        host,
        port,
        database,
        user,
        password: { kind: "inline", value: password },
        ssl_mode: sslMode,
        connect_timeout_ms: 5000,
        statement_timeout_ms: 0,
        ssl_key_path: null,
        ssl_cert_path: null,
        ssl_ca_path: null,
      },
    }),
    [name, host, port, database, user, password, sslMode]
  );

  async function loadTables(connectionId: string) {
    setBusy("tables");
    setTables([]);

    const buffer: any[][] = [];

    try {
      const opId = await operationExecute({
        connection_id: connectionId,
        kind: "sql_query",
        sql: { sql: LIST_TABLES_SQL, batch_size: 500, max_rows: 50_000 },
      });

      const unsub = listenOp(
        opId,
        (chunk) => {
          const rows: any[][] = (chunk as any).rows || [];
          buffer.push(...rows);
        },
        () => {
          const parsed: TableItem[] = buffer
            .map((r) => ({
              schema: String(r?.[0] ?? ""),
              name: String(r?.[1] ?? ""),
            }))
            .filter((t) => t.schema && t.name);

          setTables(parsed);
          setMsg(`Loaded ${parsed.length} tables.`);
          setBusy(null);
          unsub();
        },
        (e) => {
          setMsg(`LIST_TABLES_FAILED: ${errText(e)}`);
          setBusy(null);
          unsub();
        }
      );
    } catch (e: any) {
      setMsg(errText(e));
      setBusy(null);
    }
  }

  async function handleTest() {
    const err = validate();
    if (err) return setMsg(err);

    setBusy("test");
    setMsg("");

    try {
      await connectionTest(payload);
      setMsg("Test OK.");
    } catch (e: any) {
      setMsg(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleConnect() {
    const err = validate();
    if (err) return setMsg(err);

    setBusy("connect");
    setMsg("");
    setConnInfo(null);
    setTables([]);

    try {
      const res = await connectionCreate(payload);
      setConnInfo({ id: res.id, label: res.label });
      setMsg(`Connected.`);
      await loadTables(res.id);
    } catch (e: any) {
      setMsg(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const filteredTables = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) =>
      `${t.schema}.${t.name}`.toLowerCase().includes(q)
    );
  }, [tables, filter]);

  return (
    <div class="min-h-screen bg-slate-100 p-5">
      <div class="mx-auto max-w-5xl">
        <div class="grid grid-cols-[360px_1fr] gap-4">
          {/* Left: Connection panel (TablePlus-ish compact) */}
          <div class="rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.08)] overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-200">
              <div class="flex items-center justify-between">
                <div class="text-sm font-semibold text-slate-900">
                  New Connection
                </div>
                <div class="text-[11px] font-semibold text-slate-500">
                  PostgreSQL
                </div>
              </div>
            </div>

            <div class="p-4 space-y-3">
              <Field label="Name">
                <Input
                  value={name}
                  placeholder="Mochi"
                  onInput={(e: InputEvt) => setName(e.currentTarget.value)}
                />
              </Field>

              <div class="grid grid-cols-[1fr_120px] gap-2">
                <Field label="Host">
                  <Input
                    value={host}
                    placeholder="127.0.0.1"
                    onInput={(e: InputEvt) => setHost(e.currentTarget.value)}
                  />
                </Field>

                <Field label="Port">
                  <Input
                    value={String(port)}
                    inputMode="numeric"
                    onInput={(e: InputEvt) =>
                      setPort(toNumber(e.currentTarget.value, 5432))
                    }
                  />
                </Field>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <Field label="User">
                  <Input
                    value={user}
                    onInput={(e: InputEvt) => setUser(e.currentTarget.value)}
                  />
                </Field>

                <Field label="Database">
                  <Input
                    value={database}
                    onInput={(e: InputEvt) =>
                      setDatabase(e.currentTarget.value)
                    }
                  />
                </Field>
              </div>

              <Field label="Password">
                <Input
                  type="password"
                  value={password}
                  placeholder="••••••••"
                  onInput={(e: InputEvt) => setPassword(e.currentTarget.value)}
                />
              </Field>

              <Field label="SSL">
                <Select
                  value={sslMode}
                  onChange={(e: SelectEvt) =>
                    setSslMode(e.currentTarget.value as SslMode)
                  }
                >
                  <option value="disable">Disable</option>
                  <option value="prefer">Prefer</option>
                  <option value="require">Require</option>
                  <option value="verify-ca">Verify-CA</option>
                  <option value="verify-full">Verify-Full</option>
                </Select>
              </Field>

              <div class="pt-2 flex items-center gap-2">
                <button
                  type="button"
                  class={cls(
                    "h-9 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800",
                    "hover:bg-slate-50 disabled:opacity-60 disabled:hover:bg-white"
                  )}
                  disabled={!!busy}
                  onClick={handleTest}
                >
                  {busy === "test" ? "Testing…" : "Test"}
                </button>

                <button
                  type="button"
                  class={cls(
                    "h-9 flex-1 rounded-xl bg-slate-900 px-3 text-sm font-semibold text-white",
                    "hover:bg-slate-800 disabled:opacity-60"
                  )}
                  disabled={!!busy}
                  onClick={handleConnect}
                >
                  {busy === "connect" || busy === "tables"
                    ? "Connecting…"
                    : "Connect"}
                </button>
              </div>

              {msg ? (
                <div
                  class={cls(
                    "mt-2 rounded-xl border px-3 py-2 text-xs font-semibold",
                    msg.toLowerCase().includes("failed") ||
                      msg.toLowerCase().includes("error")
                      ? "border-rose-200 bg-rose-50 text-rose-700"
                      : "border-slate-200 bg-slate-50 text-slate-700"
                  )}
                >
                  {msg}
                </div>
              ) : null}

              {connInfo ? (
                <div class="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div class="text-[11px] font-semibold text-emerald-800">
                    Connected
                  </div>
                  <div class="text-xs font-medium text-emerald-900">
                    {connInfo.label}
                  </div>
                  <div class="mt-1 text-[11px] font-mono text-emerald-800">
                    {connInfo.id}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Right: Explorer (schemas/tables) */}
          <div class="rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.08)] overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-200">
              <div class="flex items-center justify-between">
                <div class="text-sm font-semibold text-slate-900">Explorer</div>

                <div class="flex items-center gap-2">
                  <div class="relative">
                    <input
                      value={filter}
                      onInput={(e: InputEvt) =>
                        setFilter(e.currentTarget.value)
                      }
                      placeholder="Search tables…"
                      class={cls(
                        "h-8 w-[260px] rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
                        "focus:border-slate-900 focus:ring-4 focus:ring-slate-200/60"
                      )}
                    />
                  </div>

                  <button
                    type="button"
                    class={cls(
                      "h-8 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700",
                      "hover:bg-slate-50 disabled:opacity-60"
                    )}
                    disabled={!connInfo || busy === "tables"}
                    onClick={() => connInfo && loadTables(connInfo.id)}
                  >
                    {busy === "tables" ? "Refreshing…" : "Refresh"}
                  </button>
                </div>
              </div>
            </div>

            <div class="p-3">
              {!connInfo ? (
                <EmptyState
                  title="No connection"
                  desc="Connect to a database to browse schemas and tables."
                />
              ) : (
                <div class="space-y-1 max-h-[520px] overflow-auto pr-1">
                  {filteredTables.length ? (
                    filteredTables.map((t) => (
                      <div class="group rounded-xl px-2 py-2 hover:bg-slate-50">
                        <div class="flex items-center justify-between">
                          <div class="min-w-0">
                            <div class="text-[11px] font-semibold text-slate-500">
                              {t.schema}
                            </div>
                            <div class="truncate text-sm font-semibold text-slate-900">
                              {t.name}
                            </div>
                          </div>
                          <div class="opacity-0 group-hover:opacity-100 transition">
                            <button
                              type="button"
                              class="h-7 rounded-lg border border-slate-300 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                              onClick={() =>
                                setMsg(`Selected: ${t.schema}.${t.name}`)
                              }
                            >
                              Open
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div class="p-4 text-xs text-slate-500">
                      {busy === "tables"
                        ? "Loading tables…"
                        : filter.trim()
                        ? "No results."
                        : "No tables loaded."}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div class="border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500 flex items-center justify-between">
              <span>
                {connInfo ? `${tables.length} tables` : "Disconnected"}
              </span>
              <span class="font-mono">{connInfo ? connInfo.label : "—"}</span>
            </div>
          </div>
        </div>

        <details class="mt-4">
          <summary class="cursor-pointer text-xs font-semibold text-slate-700">
            Debug
          </summary>
          <pre class="mt-2 rounded-2xl bg-slate-900 p-4 text-xs text-slate-100 overflow-auto">
            {JSON.stringify(
              {
                name,
                host,
                port,
                user,
                database,
                sslMode,
                connInfo,
                tablesCount: tables.length,
                filter,
              },
              null,
              2
            )}
          </pre>
        </details>
      </div>
    </div>
  );
}

/* ============================================================================
 * Small UI atoms
 * ============================================================================
 */

function Field(props: { label: string; children: any }) {
  return (
    <div class="space-y-1">
      <div class="text-[11px] font-semibold text-slate-500">{props.label}</div>
      {props.children}
    </div>
  );
}

function Input(
  props: JSX.HTMLAttributes<HTMLInputElement> & {
    value: string;
    placeholder?: string;
    type?: string;
  }
) {
  const c = cls(
    "h-9 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
    "focus:border-slate-900 focus:ring-4 focus:ring-slate-200/60",
    typeof props.class === "string" ? props.class : ""
  );
  return <input {...props} class={c} />;
}

function Select(
  props: JSX.HTMLAttributes<HTMLSelectElement> & { value: string }
) {
  const c = cls(
    "h-9 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
    "focus:border-slate-900 focus:ring-4 focus:ring-slate-200/60",
    typeof props.class === "string" ? props.class : ""
  );
  return <select {...props} class={c} />;
}

function EmptyState(props: { title: string; desc: string }) {
  return (
    <div class="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6">
      <div class="text-sm font-semibold text-slate-900">{props.title}</div>
      <div class="mt-1 text-xs text-slate-600">{props.desc}</div>
      <div class="mt-4 text-xs text-slate-500">
        Tip: Start with <span class="font-semibold">Test</span> to validate
        credentials.
      </div>
    </div>
  );
}
