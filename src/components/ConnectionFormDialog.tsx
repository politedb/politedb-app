import { JSX } from "preact";
import { useCallback, useState } from "preact/hooks";
import { useForm } from "react-hook-form";
import { v4 as uuid } from "uuid";

import {
  connectionTest,
  profileSaveAndConnect,
  type ConnectionCreateInput,
} from "../lib/tauri";
import { X } from "./icons";
import { Tab, useScreenStore } from "../stores/screen";
import { Button } from "./common/Button";
import { Select } from "./common/Select";

type InputEvt = JSX.TargetedEvent<HTMLInputElement>;
type SelectEvt = JSX.TargetedEvent<HTMLSelectElement>;

type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

const COLORS = [
  "",
  "#CBD5E1",
  "#93C5FD",
  "#FDE68A",
  "#BBF7D0",
  "#FBCFE8",
] as const;

function toNumber(v: any, fallback: number) {
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

type FormValues = {
  name: string;
  tag: string;
  statusColor: string;

  host: string;
  port: number;
  user: string;
  password: string;
  database: string;

  storeKeychain: boolean;

  sslMode: SslMode;
  sslKey: string;
  sslCert: string;
  sslCA: string;

  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
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
  const { addTab, setActiveScreen } = useScreenStore();

  const isEditing = !!initialData?.key;
  const profileId = initialData?.key ?? "";

  const [openOptions, setOpenOptions] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "test" | "connect">(null);
  const [msg, setMsg] = useState<string>("");

  const {
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<FormValues>({
    mode: "onSubmit",
    defaultValues: {
      name: initialData?.name || "Mochi",
      tag: initialData?.tag || "local",
      statusColor: initialData?.statusColor || "",

      host: initialData?.host || "127.0.0.1",
      port: initialData?.port ?? 5444,
      user: initialData?.user || "politeai",
      password: initialData?.password || "polite-assistant",
      database: initialData?.database || "politeai",

      storeKeychain: initialData?.storeKeychain || true,

      sslMode: (initialData?.sslMode as SslMode) || "prefer",
      sslKey: initialData?.sslKey || "",
      sslCert: initialData?.sslCert || "",
      sslCA: initialData?.sslCA || "",

      sshEnabled: initialData?.sshEnabled || false,
      sshHost: initialData?.sshHost || "",
      sshPort: initialData?.sshPort ?? 22,
      sshUser: initialData?.sshUser || "",
      sshKeyPath: initialData?.sshKeyPath || "",
    },
  });

  const storeKeychain = watch("storeKeychain");
  const sshEnabled = watch("sshEnabled");

  const cacheToLocalStorage = useCallback(
    (key?: string) => {
      const v = getValues();

      const profile = {
        id: initialData?.key ?? `temp:${Date.now()}`,
        name: v.name,
        tag: v.tag,
        statusColor: v.statusColor,
        host: v.host,
        port: v.port,
        user: v.user,
        database: v.database,

        // FE-only
        password: v.password,
        storeKeychain: v.storeKeychain,

        sslMode: v.sslMode,
        sslKey: v.sslKey,
        sslCert: v.sslCert,
        sslCA: v.sslCA,

        sshEnabled: v.sshEnabled,
        sshHost: v.sshHost,
        sshPort: v.sshPort,
        sshUser: v.sshUser,
        sshKeyPath: v.sshKeyPath,
      };

      const storeKey = key || `politedb:conn:${initialData?.key ?? Date.now()}`;
      localStorage.setItem(storeKey, JSON.stringify(profile));
      return storeKey;
    },
    [getValues, initialData?.key]
  );

  function buildConnectionInput(v: FormValues): ConnectionCreateInput {
    const input: any = {
      engine: "postgres",
      label: v.name,
      postgres: {
        host: v.host,
        port: toNumber(v.port, 5432),
        database: v.database,
        user: v.user,
        password: v.storeKeychain
          ? { kind: "keychain", value: "" } // lib/profileSaveAndConnect sẽ tự rewrite + resolve
          : { kind: "inline", value: v.password },
        ssl_mode: v.sslMode,
        connect_timeout_ms: 5000,
        statement_timeout_ms: 0,
        ssl_key_path: v.sslKey || null,
        ssl_cert_path: v.sslCert || null,
        ssl_ca_path: v.sslCA || null,
      },
      ssh: v.sshEnabled
        ? {
            ssh_host: v.sshHost,
            ssh_port: toNumber(v.sshPort, 22),
            ssh_user: v.sshUser || null,
            identity_file: v.sshKeyPath,
            strict_host_key_checking: "accept-new",
            connect_timeout_ms: 5000,
            remote_host: v.host,
            remote_port: toNumber(v.port, 5432),
          }
        : null,
    };

    return input as ConnectionCreateInput;
  }

  const onSave = handleSubmit(async (v) => {
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
  });

  const onTest = handleSubmit(async (v) => {
    setBusy("test");
    setMsg("");
    try {
      // NOTE: nếu storeKeychain=true mà password rỗng, test này có thể fail (vì connectionTest không resolve keychain).
      // Flow chuẩn để test trong keychain mode là dùng profileSaveAndConnect.
      const input = buildConnectionInput(v);
      await connectionTest(input);
      setMsg("Test OK.");
    } catch (e: any) {
      setMsg(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  });

  const onConnect = handleSubmit(async (v) => {
    setBusy("connect");
    setMsg("");
    try {
      const connectionInput = buildConnectionInput(v);

      const action = isEditing
        ? ({
            mode: "update",
            profileId: profileId || (initialData?.key as string),
          } as const)
        : ({ mode: "create" } as const);

      const res = await profileSaveAndConnect({
        ...action,

        // FE-only controls
        storeKeychain: v.storeKeychain,
        password: v.password,

        ...connectionInput,
      } as any);

      setMsg(`Connected ✅ ${res.profile.label}`);

      const newTab: Tab = {
        id: `tab-${uuid()}`,
        label:
          res.profile.label || connectionInput.label || "Unnamed Connection",
        runtimeConnectionId: res.connection.id,
        profileId,
      };

      addTab(newTab);
      setActiveScreen(newTab.id);
    } catch (e: any) {
      setMsg(e?.message ? String(e.message) : String(e));
    } finally {
      setBusy(null);
    }
  });

  return (
    <div class="mx-auto max-w-2xl rounded-2xl border border-neutral-200 bg-neutral-50 shadow-[0_20px_60px_rgba(15,23,42,0.10)]">
      <div class="relative px-8 py-6">
        <div class="text-center text-xl font-semibold text-neutral-900">
          PostgreSQL Connection
        </div>

        <Button
          onClick={onClose}
          variant="ghost"
          className="absolute top-3 right-3 rounded-full p-2"
        >
          <X className="size-4 text-slate-600" />
        </Button>
      </div>

      <div class="space-y-3 px-8 pb-7">
        <Row label="Name">
          <Input
            value={watch("name")}
            placeholder="Mochi"
            onInput={(e: InputEvt) => setValue("name", e.currentTarget.value)}
          />
        </Row>

        <div class="grid grid-cols-2 gap-4">
          <Row label="Status color">
            <div class="flex items-center gap-2">
              {COLORS.map((c) => (
                <button
                  type="button"
                  class={`size-8 rounded-lg border border-slate-300 ${
                    watch("statusColor") === c
                      ? "border-blue-400 ring-3 ring-blue-200"
                      : ""
                  }`}
                  style={{ background: c || "transparent" }}
                  onClick={() => setValue("statusColor", c)}
                  title={c ? c : "none"}
                />
              ))}
            </div>
          </Row>

          <Row label="Tag">
            <Select
              value={watch("tag")}
              onChange={(e: SelectEvt) =>
                setValue("tag", e.currentTarget.value)
              }
            >
              <option value="local">local</option>
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
            </Select>
          </Row>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <Row label="Host/Socket">
            <Input
              value={watch("host")}
              onInput={(e: InputEvt) => setValue("host", e.currentTarget.value)}
            />
          </Row>
          <Row label="Port">
            <Input
              value={String(watch("port"))}
              inputMode="numeric"
              onInput={(e: InputEvt) =>
                setValue("port", toNumber(e.currentTarget.value, 5432))
              }
            />
          </Row>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <Row label="User">
            <Input
              value={watch("user")}
              onInput={(e: InputEvt) => setValue("user", e.currentTarget.value)}
            />
          </Row>

          <Row label="Other options">
            <Button
              variant="outline"
              className="w-full justify-between border-neutral-300 px-2 text-sm text-neutral-600 hover:bg-neutral-100"
              onClick={() => setOpenOptions((x) => !x)}
            >
              <span>{openOptions ? "Hide" : "Show"}</span>
              <span class={`transition ${openOptions ? "rotate-180" : ""}`}>
                ▾
              </span>
            </Button>
          </Row>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <Row label="Password">
            <Input
              type="password"
              value={watch("password")}
              placeholder={
                storeKeychain
                  ? "Enter password (will be saved securely)"
                  : "Enter password (not saved)"
              }
              onInput={(e: InputEvt) =>
                setValue("password", e.currentTarget.value)
              }
            />

            {storeKeychain && !watch("password") ? (
              <div class="mt-1 text-xs text-slate-500">
                Password is already saved. Leave empty to keep existing one.
              </div>
            ) : null}

            {!storeKeychain && errors.password ? (
              <div class="mt-1 text-xs text-rose-600">
                {String(errors.password.message || "Password is required.")}
              </div>
            ) : null}
          </Row>

          <Row label="Password storage">
            <Select
              value={storeKeychain ? "keychain" : "session"}
              onChange={(e: SelectEvt) =>
                setValue("storeKeychain", e.currentTarget.value === "keychain")
              }
            >
              <option value="session">Don’t save (ask every time)</option>
              <option value="keychain">
                Save securely on this device (Keychain)
              </option>
            </Select>

            <div class="mt-2 text-xs leading-snug text-slate-500">
              {storeKeychain ? (
                <>
                  Password is encrypted and stored in your operating system’s
                  secure keychain.
                </>
              ) : (
                <>
                  Password is used for this connection only and will not be
                  saved.
                </>
              )}
            </div>
          </Row>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <Row label="Database">
            <Input
              value={watch("database")}
              onInput={(e: InputEvt) =>
                setValue("database", e.currentTarget.value)
              }
            />
          </Row>

          <Row label="">
            <Button className="w-full" disabled>
              Bootstrap commands…
            </Button>
          </Row>
        </div>

        <Row label="SSL mode">
          <Select
            value={watch("sslMode")}
            onChange={(e: SelectEvt) =>
              setValue("sslMode", e.currentTarget.value as SslMode)
            }
          >
            <option value="disable">DISABLE</option>
            <option value="prefer">PREFERRED</option>
            <option value="require">REQUIRE</option>
            <option value="verify-ca">VERIFY-CA</option>
            <option value="verify-full">VERIFY-FULL</option>
          </Select>
        </Row>

        <Row label="SSL keys">
          <div class="grid grid-cols-[1fr_1fr_1fr_34px] gap-2">
            <Input
              value={watch("sslKey")}
              placeholder="Key…"
              onInput={(e: InputEvt) =>
                setValue("sslKey", e.currentTarget.value)
              }
            />
            <Input
              value={watch("sslCert")}
              placeholder="Cert…"
              onInput={(e: InputEvt) =>
                setValue("sslCert", e.currentTarget.value)
              }
            />
            <Input
              value={watch("sslCA")}
              placeholder="CA Cert…"
              onInput={(e: InputEvt) =>
                setValue("sslCA", e.currentTarget.value)
              }
            />
            <Button
              variant="ghost"
              className="size-8 rounded-lg border border-slate-300"
              onClick={() => {
                setValue("sslKey", "");
                setValue("sslCert", "");
                setValue("sslCA", "");
              }}
              title="Clear"
            >
              –
            </Button>
          </div>
        </Row>

        {sshEnabled ? (
          <div class="grid grid-cols-2 gap-4">
            <Row label="SSH Host">
              <Input
                value={watch("sshHost")}
                placeholder="ssh.example.com"
                onInput={(e: InputEvt) =>
                  setValue("sshHost", e.currentTarget.value)
                }
              />
            </Row>
            <Row label="SSH Port">
              <Input
                value={String(watch("sshPort"))}
                inputMode="numeric"
                onInput={(e: InputEvt) =>
                  setValue("sshPort", toNumber(e.currentTarget.value, 22))
                }
              />
            </Row>
          </div>
        ) : null}

        {sshEnabled ? (
          <div class="grid grid-cols-2 gap-4">
            <Row label="SSH User">
              <Input
                value={watch("sshUser")}
                placeholder="ubuntu"
                onInput={(e: InputEvt) =>
                  setValue("sshUser", e.currentTarget.value)
                }
              />
            </Row>
            <Row label="SSH Key path">
              <Input
                value={watch("sshKeyPath")}
                placeholder="~/.ssh/id_ed25519"
                onInput={(e: InputEvt) =>
                  setValue("sshKeyPath", e.currentTarget.value)
                }
              />
            </Row>
          </div>
        ) : null}

        <div class="flex items-center justify-between pt-2">
          <Button
            variant={sshEnabled ? "default" : "shadow"}
            onClick={() => setValue("sshEnabled", !sshEnabled)}
          >
            Over SSH
          </Button>

          <div class="flex gap-3">
            <Button variant="shadow" disabled={!!busy} onClick={onSave}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>

            <Button variant="shadow" disabled={!!busy} onClick={onTest}>
              {busy === "test" ? "Testing…" : "Test"}
            </Button>

            <Button variant="default" disabled={!!busy} onClick={onConnect}>
              {busy === "connect" ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </div>

        {msg ? (
          <div
            class={`mt-3 rounded-2xl border px-4 py-3 text-sm font-semibold ${
              msg.toLowerCase().includes("failed") ||
              msg.toLowerCase().includes("error")
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
      <div class="text-right text-sm font-medium text-slate-800">
        {props.label}
      </div>
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
    "py-1 w-full rounded-md border border-slate-300 bg-white px-2 text-sm font-medium text-slate-900 outline-none",
    "focus:border-blue-400 focus:ring-2 focus:ring-blue-200/60",
    typeof props.class === "string" ? props.class : "",
  ]
    .filter(Boolean)
    .join(" ");

  return <input {...props} class={cls} />;
}

// function Select(props: JSX.HTMLAttributes<HTMLSelectElement> & { value: string }) {
//   const cls = [
//     "h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none",
//     "focus:border-blue-400 focus:ring-4 focus:ring-blue-200/60",
//     typeof props.class === "string" ? props.class : "",
//   ]
//     .filter(Boolean)
//     .join(" ");

//   return <select {...props} class={cls} />;
// }
