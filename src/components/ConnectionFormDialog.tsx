import { JSX } from "preact";
import { useCallback, useMemo, useState } from "preact/hooks";
import { connectionCreate, connectionTest, type ConnectionCreateInput } from "../lib/tauri";
import { X } from "./icons";
import { Tab, useScreenStore } from "../stores/screen";

type InputEvt = JSX.TargetedEvent<HTMLInputElement>;
type SelectEvt = JSX.TargetedEvent<HTMLSelectElement>;

type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

const COLORS = ["", "#CBD5E1", "#93C5FD", "#FDE68A", "#BBF7D0", "#FBCFE8"] as const;

function toNumber(v: string, fallback: number) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

type ConnectionData = {
  key?: string;
  name?: string;
  tag?: string;
  statusColor?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  storeKeychain?: boolean;
  sslMode?: SslMode;
  sslKey?: string;
  sslCert?: string;
  sslCA?: string;
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshKeyPath?: string;
};

export function ConnectionFormDialog({
  onSaved,
  onClose,
  initialData,
}: {
  onSaved?: () => void;
  onClose?: () => void;
  initialData?: ConnectionData;
} = {}) {
  const { tabs, setTabs, setActiveScreen } = useScreenStore();
  const [name, setName] = useState(initialData?.name || "Mochi");
  const [tag, setTag] = useState(initialData?.tag || "local");
  const [statusColor, setStatusColor] = useState<string>(initialData?.statusColor || "");

  const [host, setHost] = useState(initialData?.host || "127.0.0.1");
  const [port, setPort] = useState(initialData?.port || 5432);
  const [user, setUser] = useState(initialData?.user || "postgres");
  const [password, setPassword] = useState(initialData?.password || "");
  const [database, setDatabase] = useState(initialData?.database || "postgres");

  const [storeKeychain, setStoreKeychain] = useState(initialData?.storeKeychain || false);

  const [sslMode, setSslMode] = useState<SslMode>(initialData?.sslMode || "prefer");
  const [sslKey, setSslKey] = useState(initialData?.sslKey || "");
  const [sslCert, setSslCert] = useState(initialData?.sslCert || "");
  const [sslCA, setSslCA] = useState(initialData?.sslCA || "");

  const [openOptions, setOpenOptions] = useState(false);

  const [sshEnabled, setSshEnabled] = useState(initialData?.sshEnabled || false);
  const [sshHost, setSshHost] = useState(initialData?.sshHost || "");
  const [sshPort, setSshPort] = useState(initialData?.sshPort || 22);
  const [sshUser, setSshUser] = useState(initialData?.sshUser || "");
  const [sshKeyPath, setSshKeyPath] = useState(initialData?.sshKeyPath || "");

  const [busy, setBusy] = useState<null | "save" | "test" | "connect" | "tables">(null);
  const [msg, setMsg] = useState<string>("");

  function validate(): string | null {
    if (!name.trim()) return "Name is required.";
    if (!host.trim()) return "Host is required.";
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return "Port is invalid.";
    if (!user.trim()) return "User is required.";
    if (!database.trim()) return "Database is required.";

    if (!password) return "Password is required.";

    return null;
  }

  const keychainKey = useMemo(() => {
    const safe = name.trim().toLowerCase().replace(/\s+/g, "-") || "connection";
    return `conn:${safe}`;
  }, [name]);

  const payload: ConnectionCreateInput = useMemo(() => {
    return {
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
        ssl_key_path: sslKey || null,
        ssl_cert_path: sslCert || null,
        ssl_ca_path: sslCA || null,
      },
    };
  }, [name, host, port, database, user, password, sslMode, sslKey, sslCert, sslCA]);

  const cacheToLocalStorage = useCallback(
    (key?: string) => {
      const profile = {
        id: `politedb:conn:${keychainKey}`,
        name,
        tag,
        statusColor,
        host,
        port,
        user,
        database,
        password: { kind: "inline", value: password },
        storeKeychain,
        keychainKey,
        sslMode,
        sslKey,
        sslCert,
        sslCA,
        sshEnabled,
        sshHost,
        sshPort,
        sshUser,
        sshKeyPath,
      };

      const storeKey = key || `politedb:conn:${keychainKey}-${Date.now()}`;

      localStorage.setItem(storeKey, JSON.stringify(profile));

      return storeKey;
    },
    [
      name,
      tag,
      statusColor,
      host,
      port,
      user,
      database,
      password,
      storeKeychain,
      keychainKey,
      sslMode,
      sslKey,
      sslCert,
      sslCA,
      sshEnabled,
      sshHost,
      sshPort,
      sshUser,
      sshKeyPath,
    ]
  );

  async function handleSave() {
    const err = validate();
    if (err) return setMsg(err);

    setBusy("save");
    setMsg("");

    try {
      cacheToLocalStorage(initialData?.key);
      setMsg("Saved.");
      onSaved?.();
    } catch (e: any) {
      setMsg(e?.message ? String(e.message) : String(e));
    } finally {
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
      setMsg("Test OK. (Created connection in state)");
    } catch (e: any) {
      setMsg(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleConnect() {
    const err = validate();
    if (err) return setMsg(err);

    setBusy("connect");
    setMsg("");

    try {
      const res = await connectionCreate(payload);
      const storeKey = cacheToLocalStorage(initialData?.key);
      setMsg(`Connected ✅ ${res.label}`);

      // Create new tab
      const newTab: Tab = {
        id: `tab-${Date.now()}-conn#${storeKey}`,
        label: payload.label || "Unnamed Connection",
        connectionId: res.id,
        connectionData: payload,
      };

      setTabs([...tabs, newTab]);
      setActiveScreen(newTab.id);
    } catch (e: any) {
      setMsg(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="mx-auto max-w-4xl rounded-2xl border border-neutral-200 bg-neutral-50 shadow-[0_20px_60px_rgba(15,23,42,0.10)]">
      <div class="px-8 py-6 relative">
        <div class="text-center text-xl font-semibold text-neutral-900">PostgreSQL Connection</div>

        <button
          type="button"
          onClick={onClose}
          class="p-2 rounded-full hover:bg-neutral-50 flex items-center justify-center transition-colors cursor-pointer absolute top-3 right-3"
        >
          <X className="size-4 text-slate-600" />
        </button>
      </div>

      <div class="px-8 pb-7 space-y-4">
        <Row label="Name">
          <Input
            value={name}
            placeholder="Mochi"
            onInput={(e: InputEvt) => setName(e.currentTarget.value)}
          />
        </Row>

        <div class="grid grid-cols-2 gap-6">
          <Row label="Status color">
            <div class="flex items-center gap-3">
              {COLORS.map((c) => (
                <button
                  type="button"
                  class={`h-9 w-9 rounded-xl border border-slate-300 ${
                    statusColor === c ? "ring-4 ring-blue-200 border-blue-400" : ""
                  }`}
                  style={{ background: c || "transparent" }}
                  onClick={() => setStatusColor(c)}
                  title={c ? c : "none"}
                />
              ))}
            </div>
          </Row>

          <Row label="Tag">
            <Select value={tag} onChange={(e: SelectEvt) => setTag(e.currentTarget.value)}>
              <option value="local">local</option>
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
            </Select>
          </Row>
        </div>

        <div class="grid grid-cols-2 gap-6">
          <Row label="Host/Socket">
            <Input value={host} onInput={(e: InputEvt) => setHost(e.currentTarget.value)} />
          </Row>
          <Row label="Port">
            <Input
              value={String(port)}
              inputMode="numeric"
              onInput={(e: InputEvt) => setPort(toNumber(e.currentTarget.value, 5432))}
            />
          </Row>
        </div>

        <div class="grid grid-cols-2 gap-6">
          <Row label="User">
            <Input value={user} onInput={(e: InputEvt) => setUser(e.currentTarget.value)} />
          </Row>

          <Row label="Other options">
            <button
              type="button"
              class="h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-left font-medium text-slate-800 flex items-center justify-between hover:bg-slate-50"
              onClick={() => setOpenOptions((v) => !v)}
            >
              <span>{openOptions ? "Hide" : "Show"}</span>
              <span class={`transition ${openOptions ? "rotate-180" : ""}`}>▾</span>
            </button>
          </Row>
        </div>

        <div class="grid grid-cols-2 gap-6">
          <Row label="Password">
            <Input
              type="password"
              value={password}
              placeholder="password"
              onInput={(e: InputEvt) => setPassword(e.currentTarget.value)}
            />
          </Row>

          <Row label="Store">
            <Select
              value={storeKeychain ? "keychain" : "inline"}
              onChange={(e: SelectEvt) => setStoreKeychain(e.currentTarget.value === "keychain")}
            >
              <option value="inline">Inline (current)</option>
              <option value="keychain" disabled>
                Keychain (soon)
              </option>
            </Select>
            <div class="mt-2 text-xs text-slate-500">
              Key: <span class="font-mono text-slate-900">{keychainKey}</span>
            </div>
          </Row>
        </div>

        <div class="grid grid-cols-2 gap-6">
          <Row label="Database">
            <Input value={database} onInput={(e: InputEvt) => setDatabase(e.currentTarget.value)} />
          </Row>

          <Row label="">
            <button
              type="button"
              class="py-2 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-sm text-slate-600 cursor-not-allowed"
              disabled
            >
              Bootstrap commands…
            </button>
          </Row>
        </div>

        <Row label="SSL mode">
          <Select
            value={sslMode}
            onChange={(e: SelectEvt) => setSslMode(e.currentTarget.value as SslMode)}
          >
            <option value="disable">DISABLE</option>
            <option value="prefer">PREFERRED</option>
            <option value="require">REQUIRE</option>
            <option value="verify-ca">VERIFY-CA</option>
            <option value="verify-full">VERIFY-FULL</option>
          </Select>
        </Row>

        <Row label="SSL keys">
          <div class="grid grid-cols-[1fr_1fr_1fr_40px] gap-3">
            <Input
              value={sslKey}
              placeholder="Key…"
              onInput={(e: InputEvt) => setSslKey(e.currentTarget.value)}
            />
            <Input
              value={sslCert}
              placeholder="Cert…"
              onInput={(e: InputEvt) => setSslCert(e.currentTarget.value)}
            />
            <Input
              value={sslCA}
              placeholder="CA Cert…"
              onInput={(e: InputEvt) => setSslCA(e.currentTarget.value)}
            />
            <button
              type="button"
              class="h-10 w-10 rounded-xl border border-slate-300 bg-white font-bold text-slate-700 hover:bg-slate-50"
              onClick={() => {
                setSslKey("");
                setSslCert("");
                setSslCA("");
              }}
              title="Clear"
            >
              –
            </button>
          </div>
        </Row>

        {sshEnabled ? (
          <div class="grid grid-cols-2 gap-6">
            <Row label="SSH Host">
              <Input
                value={sshHost}
                placeholder="ssh.example.com"
                onInput={(e: InputEvt) => setSshHost(e.currentTarget.value)}
              />
            </Row>
            <Row label="SSH Port">
              <Input
                value={String(sshPort)}
                inputMode="numeric"
                onInput={(e: InputEvt) => setSshPort(toNumber(e.currentTarget.value, 22))}
              />
            </Row>
          </div>
        ) : null}

        {sshEnabled ? (
          <div class="grid grid-cols-2 gap-6">
            <Row label="SSH User">
              <Input
                value={sshUser}
                placeholder="ubuntu"
                onInput={(e: InputEvt) => setSshUser(e.currentTarget.value)}
              />
            </Row>
            <Row label="SSH Key path">
              <Input
                value={sshKeyPath}
                placeholder="~/.ssh/id_ed25519"
                onInput={(e: InputEvt) => setSshKeyPath(e.currentTarget.value)}
              />
            </Row>
          </div>
        ) : null}

        <div class="pt-2 flex items-center justify-between">
          <button
            type="button"
            class={`px-4 py-2 cursor-pointer text-sm rounded-xl border border-slate-300 font-semibold ${
              sshEnabled
                ? "bg-blue-500 text-white hover:bg-blue-600"
                : "bg-slate-50 text-slate-800 hover:bg-slate-100 "
            }`}
            onClick={() => setSshEnabled((prev) => !prev)}
          >
            Over SSH
          </button>

          <div class="flex gap-3">
            <button
              class="py-2 cursor-pointer text-sm rounded-xl border border-slate-300 bg-white px-6 font-semibold hover:bg-slate-50 disabled:opacity-60"
              disabled={!!busy}
              onClick={handleSave}
            >
              {busy === "save" ? "Saving…" : "Save"}
            </button>

            <button
              class="py-2 cursor-pointer text-sm rounded-xl border border-slate-300 bg-white px-6 font-semibold hover:bg-slate-50 disabled:opacity-60"
              disabled={!!busy}
              onClick={handleTest}
            >
              {busy === "test" ? "Testing…" : "Test"}
            </button>

            <button
              class="py-2 cursor-pointer text-sm rounded-xl bg-blue-600 px-5 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              disabled={!!busy}
              onClick={handleConnect}
            >
              {busy === "connect" || busy === "tables" ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>

        {msg ? (
          <div
            class={`mt-3 rounded-2xl border px-4 py-3 text-sm font-semibold ${
              msg.toLowerCase().includes("failed") || msg.toLowerCase().includes("error")
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-slate-200 bg-slate-50 text-slate-700"
            }`}
          >
            {msg}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Row(props: { label: string; children: any }) {
  return (
    <div class="grid grid-cols-[100px_1fr] items-center gap-3">
      <div class="text-right text-sm font-medium text-slate-800">{props.label}</div>
      <div>{props.children}</div>
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
  const cls = [
    "h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
    "focus:border-blue-400 focus:ring-4 focus:ring-blue-200/60",
    typeof props.class === "string" ? props.class : "",
  ]
    .filter(Boolean)
    .join(" ");

  return <input {...props} class={cls} />;
}

function Select(props: JSX.HTMLAttributes<HTMLSelectElement> & { value: string }) {
  const cls = [
    "h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
    "focus:border-blue-400 focus:ring-4 focus:ring-blue-200/60",
    typeof props.class === "string" ? props.class : "",
  ]
    .filter(Boolean)
    .join(" ");

  return <select {...props} class={cls} />;
}
