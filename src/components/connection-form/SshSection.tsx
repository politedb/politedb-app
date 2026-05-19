import { TargetedEvent } from "preact";
import { open } from "@tauri-apps/plugin-dialog";
import { useController, useWatch } from "react-hook-form";
import { Field, Input } from "src/components/form";
import { Button } from "../common/Button";
import { FilePathPicker } from "../common/FilePathPicker";
import type { SectionProps } from "./connectionForm.utils";
import { Select } from "../common/Select";
import { toNumber } from "src/utils/convert";

type InputEvt = TargetedEvent<HTMLInputElement>;

export function SSHSection(props: SectionProps) {
  const { control, onDirty } = props;
  const engine = useWatch({ control, name: "engine" });
  const isSqlite = engine === "sqlite" || engine === "d1";

  const sshEnabled = useController({ control, name: "sshEnabled" });

  // Use watch for conditional validation
  const enabled = !!useWatch({ control, name: "sshEnabled" });
  const authType = useWatch({ control, name: "sshAuthType" });

  const isKeyAuth =
    authType === "privateKey" || authType === "privateKeyWithPassphrase";
  const isPasswordAuth = authType === "password";

  const sshHost = useController({
    control,
    name: "sshHost",
    rules: enabled ? { required: "SSH host is required." } : undefined,
  });

  const sshPort = useController({
    control,
    name: "sshPort",
    rules: enabled
      ? {
          required: "SSH port is required.",
          validate: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return "SSH port is invalid.";
            if (n <= 0 || n > 65535) return "SSH port must be 1..65535.";
            return true;
          },
        }
      : undefined,
  });

  const sshUser = useController({
    control,
    name: "sshUser",
    rules: enabled ? { required: "SSH user is required." } : undefined,
  });

  const sshAuthType = useController({
    control,
    name: "sshAuthType",
    rules: enabled
      ? { required: "Authentication method is required." }
      : undefined,
  });

  const sshKeyPath = useController({
    control,
    name: "sshKeyPath",
    rules: {
      validate: (value) => {
        if (!enabled || !isKeyAuth) return true;
        return value?.trim() ? true : "SSH private key file is required.";
      },
    },
  });

  const sshPassword = useController({
    control,
    name: "sshPassword",
    rules: {
      validate: (value) => {
        if (!enabled || !isPasswordAuth) return true;
        return value?.trim() ? true : "SSH password is required.";
      },
    },
  });

  function dirty() {
    onDirty?.();
  }

  async function pickSSHKeyPath(): Promise<string | null> {
    const res = await open({ multiple: false, directory: false });
    if (!res) return null;
    return Array.isArray(res) ? (res[0] ?? null) : res;
  }

  // Errors (from RHF)
  const hostErr = sshHost.fieldState.error?.message;
  const portErr = sshPort.fieldState.error?.message;
  const userErr = sshUser.fieldState.error?.message;
  const authErr = sshAuthType.fieldState.error?.message;
  const keyErr = sshKeyPath.fieldState.error?.message;
  const pwErr = sshPassword.fieldState.error?.message;

  if (isSqlite) return null;

  return (
    <section class="rounded-2xl border border-slate-200 bg-white p-5">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-sm font-semibold text-slate-900">Over SSH</div>
          <div class="mt-1 text-xs text-slate-500">
            Create a tunnel and connect to the remote database.
          </div>
        </div>

        <Button
          variant={enabled ? "default" : "shadow"}
          onClick={() => {
            sshEnabled.field.onChange(!enabled);
            dirty();
          }}
        >
          {enabled ? "Enabled" : "Disabled"}
        </Button>
      </div>

      {enabled ? (
        <div class="mt-4 space-y-4">
          {/* Host / Port */}
          <Field label="SSH Host / Port" alignTop>
            <div class="space-y-2">
              <div class="grid grid-cols-3 gap-3">
                <Input
                  class="col-span-2"
                  value={sshHost.field.value}
                  placeholder="ssh.example.com"
                  error={!!hostErr}
                  onInput={(e: InputEvt) => {
                    sshHost.field.onChange(e.currentTarget.value);
                    dirty();
                  }}
                />

                <Input
                  value={String(sshPort.field.value ?? "")}
                  inputMode="numeric"
                  placeholder="22"
                  error={!!portErr}
                  onInput={(e: InputEvt) => {
                    sshPort.field.onChange(toNumber(e.currentTarget.value, 22));
                    dirty();
                  }}
                />
              </div>
            </div>
          </Field>

          {/* User */}
          <Field label="SSH User" alignTop>
            <div class="space-y-2">
              <Input
                value={sshUser.field.value}
                placeholder="ubuntu"
                error={!!userErr}
                onInput={(e: InputEvt) => {
                  sshUser.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
            </div>
          </Field>

          {/* Auth + Secret */}
          <Field label="Authentication" alignTop>
            <div class="space-y-2">
              <div class="grid grid-cols-[2fr_3fr] gap-2">
                <Select
                  class="h-10"
                  value={sshAuthType.field.value}
                  error={!!authErr}
                  onChange={(e) => {
                    const next = e.currentTarget.value;

                    sshAuthType.field.onChange(next);

                    // clear irrelevant field
                    if (next === "password") {
                      sshKeyPath.field.onChange("");
                    } else {
                      sshPassword.field.onChange("");
                    }

                    dirty();
                  }}
                >
                  <option value="privateKey">Private Key</option>
                  <option value="password">Password</option>
                </Select>

                {isKeyAuth ? (
                  <FilePathPicker
                    value={sshKeyPath.field.value}
                    placeholder="~/.ssh/id_ed25519"
                    error={!!keyErr}
                    onPick={async () => {
                      const p = await pickSSHKeyPath();
                      if (p) {
                        sshKeyPath.field.onChange(p);
                        dirty();
                      }
                    }}
                    onClear={() => {
                      sshKeyPath.field.onChange("");
                      dirty();
                    }}
                  />
                ) : (
                  <Input
                    type="password"
                    value={sshPassword.field.value ?? ""}
                    placeholder="SSH password"
                    error={!!pwErr}
                    onInput={(e: InputEvt) => {
                      sshPassword.field.onChange(e.currentTarget.value);
                      dirty();
                    }}
                  />
                )}
              </div>

              {authErr ? (
                <div class="text-xs font-medium text-rose-600">
                  {_attach(authErr)}
                </div>
              ) : null}
            </div>
          </Field>
        </div>
      ) : null}
    </section>
  );
}

// Helps TS accept `string | undefined` while keeping code tidy
function _attach(s: string | undefined) {
  return s ?? "";
}
