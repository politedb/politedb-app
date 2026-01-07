// import { JSX } from "preact";
// import { useMemo, useState } from "preact/hooks";
// import { connectionTest } from "../lib/tauri/connection";
// import { operationExecute } from "../lib/tauri/operation";
// import { listenOp } from "../lib/tauri/events";
// import type { ConnectionCreateInput } from "../lib/tauri";
// import { cellToString } from "../utils/convert";

// type InputEvt = JSX.TargetedEvent<HTMLInputElement>;
// type SelectEvt = JSX.TargetedEvent<HTMLSelectElement>;

// type RedisSslMode = "disable" | "prefer" | "require";

// function toNumber(v: string, fallback: number) {
//   const x = Number(v);
//   return Number.isFinite(x) ? x : fallback;
// }

// function cls(...xs: Array<string | false | null | undefined>) {
//   return xs.filter(Boolean).join(" ");
// }

// function errText(e: any) {
//   if (!e) return "UNKNOWN_ERROR";
//   if (typeof e === "string") return e;
//   if (e?.error) return String(e.error);
//   if (e?.message) return String(e.message);
//   try {
//     return JSON.stringify(e);
//   } catch {
//     return String(e);
//   }
// }

// export function RedisConnectionDialog() {
//   const [name, setName] = useState("Redis Local");
//   const [host, setHost] = useState("127.0.0.1");
//   const [port, setPort] = useState(6379);
//   const [user, setUser] = useState(""); // ACL optional
//   const [password, setPassword] = useState("");
//   const [db, setDb] = useState(0);
//   const [sslMode, setSslMode] = useState<RedisSslMode>("prefer");

//   const [busy, setBusy] = useState<null | "test" | "connect" | "keys">(null);
//   const [msg, setMsg] = useState<string>("");
//   const [connInfo, setConnInfo] = useState<{
//     id: string;
//     label: string;
//   } | null>(null);

//   const [keys, setKeys] = useState<string[]>([]);
//   const [filter, setFilter] = useState("");

//   function validate(): string | null {
//     if (!name.trim()) return "Name is required.";
//     if (!host.trim()) return "Host is required.";
//     if (!Number.isFinite(port) || port <= 0 || port > 65535)
//       return "Port is invalid.";
//     if (!Number.isFinite(db) || db < 0) return "DB is invalid.";
//     // password có thể empty nếu redis không require
//     return null;
//   }

//   const payload: ConnectionCreateInput = useMemo(
//     () => ({
//       engine: "redis",
//       label: name,
//       // NOTE: mày cần thêm redis type vào ConnectionCreateInput ở lib/tauri types
//       redis: {
//         host,
//         port,
//         user: user.trim() ? user : null,
//         password: password
//           ? { kind: "inline", value: password }
//           : { kind: "inline", value: "" },
//         db,
//         ssl_mode: sslMode,
//         connect_timeout_ms: 5000,
//         command_timeout_ms: 5000,
//       },
//     }),
//     [name, host, port, user, password, db, sslMode]
//   );

//   async function listKeys(connectionId: string) {
//     setBusy("keys");
//     setKeys([]);

//     const pattern = filter.trim() ? `*${filter.trim()}*` : "*";

//     try {
//       const opId = await operationExecute({
//         connection_id: connectionId,
//         kind: "redis_command",
//         redis: { command: "KEYS", args: [pattern], command_timeout_ms: 10_000 },
//       });

//       const unsub = listenOp(
//         opId,
//         undefined as any,
//         // onDone:
//         (donePayload: any) => {
//           const items = (donePayload?.items ??
//             donePayload?.result?.items ??
//             []) as any[];
//           const parsed = items.map((x) => cellToString(x)).filter(Boolean);

//           setKeys(parsed);
//           setMsg(`Loaded ${parsed.length} keys.`);
//           setBusy(null);
//           unsub();
//         },
//         (e: any) => {
//           setMsg(`LIST_KEYS_FAILED: ${errText(e)}`);
//           setBusy(null);
//           unsub();
//         }
//       );
//     } catch (e: any) {
//       setMsg(errText(e));
//       setBusy(null);
//     }
//   }

//   async function handleTest() {
//     const err = validate();
//     if (err) return setMsg(err);

//     setBusy("test");
//     setMsg("");

//     try {
//       await connectionTest(payload);
//       setMsg("Test OK.");
//     } catch (e: any) {
//       setMsg(errText(e));
//     } finally {
//       setBusy(null);
//     }
//   }

//   async function handleConnect() {
//     const err = validate();
//     if (err) return setMsg(err);

//     setBusy("connect");
//     setMsg("");
//     setConnInfo(null);
//     setKeys([]);

//     try {
//       const res = await connectionCreate(payload);
//       setConnInfo({ id: res.id, label: res.label });
//       setMsg("Connected.");
//       await listKeys(res.id);
//     } catch (e: any) {
//       setMsg(errText(e));
//     } finally {
//       setBusy(null);
//     }
//   }

//   const filteredKeys = useMemo(() => {
//     const q = filter.trim().toLowerCase();
//     if (!q) return keys;
//     return keys.filter((k) => k.toLowerCase().includes(q));
//   }, [keys, filter]);

//   return (
//     <div class="min-h-screen bg-slate-100 p-5">
//       <div class="mx-auto max-w-5xl">
//         <div class="grid grid-cols-[360px_1fr] gap-4">
//           {/* Left: Connection panel */}
//           <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
//             <div class="border-b border-slate-200 px-4 py-3">
//               <div class="flex items-center justify-between">
//                 <div class="text-sm font-semibold text-slate-900">
//                   New Connection
//                 </div>
//                 <div class="text-[11px] font-semibold text-slate-500">
//                   Redis
//                 </div>
//               </div>
//             </div>

//             <div class="space-y-3 p-4">
//               <Field label="Name">
//                 <Input
//                   value={name}
//                   placeholder="Redis Local"
//                   onInput={(e: InputEvt) => setName(e.currentTarget.value)}
//                 />
//               </Field>

//               <div class="grid grid-cols-[1fr_120px] gap-2">
//                 <Field label="Host">
//                   <Input
//                     value={host}
//                     placeholder="127.0.0.1"
//                     onInput={(e: InputEvt) => setHost(e.currentTarget.value)}
//                   />
//                 </Field>

//                 <Field label="Port">
//                   <Input
//                     value={String(port)}
//                     inputMode="numeric"
//                     onInput={(e: InputEvt) =>
//                       setPort(toNumber(e.currentTarget.value, 6379))
//                     }
//                   />
//                 </Field>
//               </div>

//               <div class="grid grid-cols-2 gap-2">
//                 <Field label="User (optional)">
//                   <Input
//                     value={user}
//                     placeholder="default"
//                     onInput={(e: InputEvt) => setUser(e.currentTarget.value)}
//                   />
//                 </Field>

//                 <Field label="DB">
//                   <Input
//                     value={String(db)}
//                     inputMode="numeric"
//                     onInput={(e: InputEvt) =>
//                       setDb(toNumber(e.currentTarget.value, 0))
//                     }
//                   />
//                 </Field>
//               </div>

//               <Field label="Password (optional)">
//                 <Input
//                   type="password"
//                   value={password}
//                   placeholder="••••••••"
//                   onInput={(e: InputEvt) => setPassword(e.currentTarget.value)}
//                 />
//               </Field>

//               <Field label="SSL">
//                 <Select
//                   value={sslMode}
//                   onChange={(e: SelectEvt) =>
//                     setSslMode(e.currentTarget.value as RedisSslMode)
//                   }
//                 >
//                   <option value="disable">Disable</option>
//                   <option value="prefer">Prefer</option>
//                   <option value="require">Require</option>
//                 </Select>
//               </Field>

//               <div class="flex items-center gap-2 pt-2">
//                 <button
//                   type="button"
//                   class={cls(
//                     "h-9 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800",
//                     "hover:bg-slate-50 disabled:opacity-60 disabled:hover:bg-white"
//                   )}
//                   disabled={!!busy}
//                   onClick={handleTest}
//                 >
//                   {busy === "test" ? "Testing…" : "Test"}
//                 </button>

//                 <button
//                   type="button"
//                   class={cls(
//                     "h-9 flex-1 rounded-xl bg-slate-900 px-3 text-sm font-semibold text-white",
//                     "hover:bg-slate-800 disabled:opacity-60"
//                   )}
//                   disabled={!!busy}
//                   onClick={handleConnect}
//                 >
//                   {busy === "connect" || busy === "keys"
//                     ? "Connecting…"
//                     : "Connect"}
//                 </button>
//               </div>

//               {msg ? (
//                 <div
//                   class={cls(
//                     "mt-2 rounded-xl border px-3 py-2 text-xs font-semibold",
//                     msg.toLowerCase().includes("failed") ||
//                       msg.toLowerCase().includes("error")
//                       ? "border-rose-200 bg-rose-50 text-rose-700"
//                       : "border-slate-200 bg-slate-50 text-slate-700"
//                   )}
//                 >
//                   {msg}
//                 </div>
//               ) : null}

//               {connInfo ? (
//                 <div class="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
//                   <div class="text-[11px] font-semibold text-emerald-800">
//                     Connected
//                   </div>
//                   <div class="text-xs font-medium text-emerald-900">
//                     {connInfo.label}
//                   </div>
//                   <div class="mt-1 font-mono text-[11px] text-emerald-800">
//                     {connInfo.id}
//                   </div>
//                 </div>
//               ) : null}
//             </div>
//           </div>

//           {/* Right: Keys */}
//           <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
//             <div class="border-b border-slate-200 px-4 py-3">
//               <div class="flex items-center justify-between">
//                 <div class="text-sm font-semibold text-slate-900">Keys</div>

//                 <div class="flex items-center gap-2">
//                   <input
//                     value={filter}
//                     onInput={(e: InputEvt) => setFilter(e.currentTarget.value)}
//                     placeholder="Filter keys…"
//                     class={cls(
//                       "h-8 w-[260px] rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
//                       "focus:border-slate-900 focus:ring-4 focus:ring-slate-200/60"
//                     )}
//                   />

//                   <button
//                     type="button"
//                     class={cls(
//                       "h-8 rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700",
//                       "hover:bg-slate-50 disabled:opacity-60"
//                     )}
//                     disabled={!connInfo || busy === "keys"}
//                     onClick={() => connInfo && listKeys(connInfo.id)}
//                   >
//                     {busy === "keys" ? "Refreshing…" : "Refresh"}
//                   </button>
//                 </div>
//               </div>
//             </div>

//             <div class="p-3">
//               {!connInfo ? (
//                 <EmptyState
//                   title="No connection"
//                   desc="Connect to Redis to list keys."
//                 />
//               ) : (
//                 <div class="max-h-[520px] space-y-1 overflow-auto pr-1">
//                   {filteredKeys.length ? (
//                     filteredKeys.map((k) => (
//                       <div class="group rounded-xl px-2 py-2 hover:bg-slate-50">
//                         <div class="flex items-center justify-between">
//                           <div class="truncate text-sm font-semibold text-slate-900">
//                             {k}
//                           </div>
//                           <div class="opacity-0 transition group-hover:opacity-100">
//                             <button
//                               type="button"
//                               class="h-7 rounded-lg border border-slate-300 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
//                               onClick={() => setMsg(`Selected: ${k}`)}
//                             >
//                               Select
//                             </button>
//                           </div>
//                         </div>
//                       </div>
//                     ))
//                   ) : (
//                     <div class="p-4 text-xs text-slate-500">
//                       {busy === "keys"
//                         ? "Loading keys…"
//                         : filter.trim()
//                           ? "No results."
//                           : "No keys loaded."}
//                     </div>
//                   )}
//                 </div>
//               )}
//             </div>

//             <div class="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-[11px] text-slate-500">
//               <span>{connInfo ? `${keys.length} keys` : "Disconnected"}</span>
//               <span class="font-mono">{connInfo ? connInfo.label : "—"}</span>
//             </div>
//           </div>
//         </div>

//         <details class="mt-4">
//           <summary class="cursor-pointer text-xs font-semibold text-slate-700">
//             Debug
//           </summary>
//           <pre class="mt-2 overflow-auto rounded-2xl bg-slate-900 p-4 text-xs text-slate-100">
//             {JSON.stringify(
//               {
//                 name,
//                 host,
//                 port,
//                 user,
//                 db,
//                 sslMode,
//                 connInfo,
//                 keysCount: keys.length,
//                 filter,
//               },
//               null,
//               2
//             )}
//           </pre>
//         </details>
//       </div>
//     </div>
//   );
// }

// /* ============================================================================
//  * Small UI atoms
//  * ============================================================================
//  */

// function Field(props: { label: string; children: any }) {
//   return (
//     <div class="space-y-1">
//       <div class="text-[11px] font-semibold text-slate-500">{props.label}</div>
//       {props.children}
//     </div>
//   );
// }

// function Input(
//   props: JSX.HTMLAttributes<HTMLInputElement> & {
//     value: string;
//     placeholder?: string;
//     type?: string;
//   }
// ) {
//   const c = cls(
//     "h-9 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
//     "focus:border-slate-900 focus:ring-4 focus:ring-slate-200/60",
//     typeof props.class === "string" ? props.class : ""
//   );
//   return <input {...props} class={c} />;
// }

// function Select(
//   props: JSX.HTMLAttributes<HTMLSelectElement> & { value: string }
// ) {
//   const c = cls(
//     "h-9 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
//     "focus:border-slate-900 focus:ring-4 focus:ring-slate-200/60",
//     typeof props.class === "string" ? props.class : ""
//   );
//   return <select {...props} class={c} />;
// }

// function EmptyState(props: { title: string; desc: string }) {
//   return (
//     <div class="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6">
//       <div class="text-sm font-semibold text-slate-900">{props.title}</div>
//       <div class="mt-1 text-xs text-slate-600">{props.desc}</div>
//       <div class="mt-4 text-xs text-slate-500">
//         Tip: Start with <span class="font-semibold">Test</span> to validate
//         credentials.
//       </div>
//     </div>
//   );
// }
