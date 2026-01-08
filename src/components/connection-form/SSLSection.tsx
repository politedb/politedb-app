import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { Field } from "src/components/form";
import { SslMode } from "src/lib/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import { FilePathPicker } from "src/components/common/FilePathPicker";

const SSL_MODE_META: Record<SslMode, { label: string; hint: string }> = {
  disable: {
    label: "DISABLE",
    hint: "No TLS. Traffic is unencrypted. Use only for local/dev.",
  },
  prefer: {
    label: "PREFERRED",
    hint: "Try TLS first, fall back to plain connection if TLS isn't available.",
  },
  require: {
    label: "REQUIRE",
    hint: "TLS is required, but server certificate is NOT verified (MITM still possible).",
  },
  "verify-ca": {
    label: "VERIFY-CA",
    hint: "TLS + verify server certificate against CA, but hostname is NOT checked.",
  },
  "verify-full": {
    label: "VERIFY-FULL",
    hint: "TLS + verify CA + verify hostname (recommended for production).",
  },
};

const SSL_MODE_ORDER: SslMode[] = [
  "disable",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
];

export function SSLSection(props: {
  sslMode: SslMode;
  sslKey: string;
  sslCert: string;
  sslCA: string;

  onChangeSslMode: (mode: SslMode) => void;
  onChangeSslKey: (v: string) => void;
  onChangeSslCert: (v: string) => void;
  onChangeSslCA: (v: string) => void;
}) {
  const {
    sslMode,
    sslKey,
    sslCert,
    sslCA,
    onChangeSslMode,
    onChangeSslKey,
    onChangeSslCert,
    onChangeSslCA,
  } = props;

  const modeSupportsTls = sslMode !== "disable";

  async function pickCertPath(): Promise<string | null> {
    const res = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Certificates", extensions: ["pem", "crt", "cer", "key"] },
      ],
    });
    if (!res) return null;
    return Array.isArray(res) ? (res[0] ?? null) : res;
  }

  return (
    <div class="space-y-2">
      <Field label="SSL mode">
        {/* Tooltip wrapper MUST be block/w-full so Select can be full width */}
        <Tooltip content={SSL_MODE_META[sslMode].hint}>
          <div class="w-full">
            <Select
              value={sslMode}
              onChange={(e) =>
                onChangeSslMode(e.currentTarget.value as SslMode)
              }
            >
              {SSL_MODE_ORDER.map((mode) => (
                <option key={mode} value={mode}>
                  {SSL_MODE_META[mode].label}
                </option>
              ))}
            </Select>
          </div>
        </Tooltip>
      </Field>

      {modeSupportsTls ? (
        <div class="mt-5">
          <div class="mb-2 text-xs text-slate-500">
            Optional. Leave empty if you don’t use client certificates.
          </div>
          <div class="grid grid-cols-[1fr_1fr_1fr] gap-2">
            <div class="min-w-0">
              <FilePathPicker
                value={sslKey}
                placeholder="Key path…"
                onPick={async () => {
                  const p = await pickCertPath();
                  if (p) onChangeSslKey(p);
                }}
                onClear={() => onChangeSslKey("")}
              />
            </div>
            <div class="min-w-0">
              <FilePathPicker
                value={sslCert}
                placeholder="Cert path…"
                onPick={async () => {
                  const p = await pickCertPath();
                  if (p) onChangeSslCert(p);
                }}
                onClear={() => onChangeSslCert("")}
              />
            </div>
            <div class="min-w-0">
              <FilePathPicker
                value={sslCA}
                placeholder="CA path…"
                onPick={async () => {
                  const p = await pickCertPath();
                  if (p) onChangeSslCA(p);
                }}
                onClear={() => onChangeSslCA("")}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
