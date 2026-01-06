import { Control, FieldErrors } from "react-hook-form";
import type { ConnectionCreateInput, SslMode } from "src/lib/tauri";

export type FormValues = {
  name: string;

  tags: string[];
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

  sshAuthType: "password" | "privateKey" | "privateKeyWithPassphrase";
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
  sshPassword: string;
  sshPasswordSaveMethod: "keychain" | "never";
  sshPassphrase: string;
};

export type ProfileConnectionData = {
  key?: string;
  name?: string;

  tag?: string; // legacy
  tags?: string[];

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

  sshAuthType?: "password" | "privateKey" | "privateKeyWithPassphrase";
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshKeyPath?: string;
  sshPassword?: string;
  sshPasswordSaveMethod?: "keychain" | "never";
  sshPassphrase?: string;
};

export type SectionProps = {
  control: Control<FormValues>;
  errors?: FieldErrors<FormValues>;
  onDirty?: () => void;
};

export function toNumber(v: any, fallback: number) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function normalizeTag(s: string) {
  return s
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .toLowerCase();
}

export function dedupeKeepOrder(xs: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export function buildConnectionInput(v: FormValues): ConnectionCreateInput {
  const input: any = {
    engine: "postgres",
    label: v.name,
    postgres: {
      host: v.host,
      port: toNumber(v.port, 5432),
      database: v.database,
      user: v.user,
      password: v.storeKeychain
        ? { kind: "keychain", value: "" }
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

export function makeDefaultValues(
  initialData?: ProfileConnectionData
): FormValues {
  const initialTags = initialData?.tags?.length
    ? initialData.tags
    : initialData?.tag
      ? [initialData.tag]
      : ["local"];

  return {
    name: initialData?.name || "Mochi",

    tags: dedupeKeepOrder(initialTags.map(normalizeTag)),
    statusColor: initialData?.statusColor || "",

    host: initialData?.host || "127.0.0.1",
    port: initialData?.port ?? 5444,
    user: initialData?.user || "politeai",
    password: initialData?.password || "polite-assistant",
    database: initialData?.database || "politeai",

    storeKeychain: initialData?.storeKeychain ?? true,

    sslMode: (initialData?.sslMode as SslMode) || "prefer",
    sslKey: initialData?.sslKey || "",
    sslCert: initialData?.sslCert || "",
    sslCA: initialData?.sslCA || "",

    sshAuthType: initialData?.sshAuthType || "privateKey",
    sshEnabled: initialData?.sshEnabled || false,
    sshHost: initialData?.sshHost || "",
    sshPort: initialData?.sshPort ?? 22,
    sshUser: initialData?.sshUser || "",
    sshKeyPath: initialData?.sshKeyPath || "",
    sshPassword: initialData?.sshPassword || "",
    sshPasswordSaveMethod: initialData?.sshPasswordSaveMethod || "keychain",
    sshPassphrase: initialData?.sshPassphrase || "",
  };
}
