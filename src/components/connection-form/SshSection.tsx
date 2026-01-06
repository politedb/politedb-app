import { TargetedEvent } from "preact";
import { open } from "@tauri-apps/plugin-dialog";
import { useController } from "react-hook-form";
import { Field, Input } from "src/components/form";
import { Button } from "../common/Button";
import { FilePathPicker } from "../common/FilePathPicker";
import type { SectionProps } from "./connectionForm.utils";
import { Select } from "../common/Select";

type InputEvt = TargetedEvent<HTMLInputElement>;

function toNumber(v: any, fallback: number) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export function SSHSection(props: SectionProps) {
  const { control, onDirty } = props;

  const sshEnabled = useController({ control, name: "sshEnabled" });
  const sshHost = useController({ control, name: "sshHost" });
  const sshPort = useController({ control, name: "sshPort" });
  const sshUser = useController({ control, name: "sshUser" });

  const sshAuthType = useController({ control, name: "sshAuthType" });
  const sshKeyPath = useController({ control, name: "sshKeyPath" });
  const sshPassword = useController({ control, name: "sshPassword" });
  // const sshPassphrase = useController({ control, name: "sshPassphrase" });

  function dirty() {
    onDirty?.();
  }

  async function pickSSHKeyPath(): Promise<string | null> {
    const res = await open({
      multiple: false,
      directory: false,
    });

    if (!res) return null;
    return Array.isArray(res) ? (res[0] ?? null) : res;
  }

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
          variant={sshEnabled.field.value ? "default" : "shadow"}
          onClick={() => {
            sshEnabled.field.onChange(!sshEnabled.field.value);
            dirty();
          }}
        >
          {sshEnabled.field.value ? "Enabled" : "Disabled"}
        </Button>
      </div>

      {sshEnabled.field.value ? (
        <div class="mt-4 space-y-4">
          {/* Host / Port */}
          <Field label="SSH Host / Port">
            <div class="grid grid-cols-3 gap-3">
              <Input
                class="col-span-2"
                value={sshHost.field.value}
                placeholder="ssh.example.com"
                onInput={(e: InputEvt) => {
                  sshHost.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
              <Input
                value={String(sshPort.field.value ?? "")}
                inputMode="numeric"
                placeholder="22"
                onInput={(e: InputEvt) => {
                  sshPort.field.onChange(toNumber(e.currentTarget.value, 22));
                  dirty();
                }}
              />
            </div>
          </Field>

          {/* User / Auth */}
          <Field label="SSH User / Authentication">
            <div class="grid grid-cols-2 gap-3">
              <Input
                value={sshUser.field.value}
                placeholder="ubuntu"
                onInput={(e: InputEvt) => {
                  sshUser.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
              <Select
                value={sshAuthType.field.value}
                onChange={(e) => {
                  sshAuthType.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              >
                <option value="privateKey">Private Key (No password)</option>
                {/* <option value="privateKeyWithPassphrase">
                  Private Key + Passphrase
                </option> */}
                <option value="password">Password</option>
              </Select>
            </div>
          </Field>

          {/* Private key */}
          {(sshAuthType.field.value === "privateKey" ||
            sshAuthType.field.value === "privateKeyWithPassphrase") && (
            <Field label="SSH Private Key">
              <FilePathPicker
                value={sshKeyPath.field.value}
                placeholder="~/.ssh/id_ed25519"
                onPick={async () => {
                  const p = await pickSSHKeyPath();
                  if (p) sshKeyPath.field.onChange(p);
                }}
                onClear={() => sshKeyPath.field.onChange("")}
              />
            </Field>
          )}

          {/* Passphrase (no save option) */}
          {/* {sshAuthType.field.value === "privateKeyWithPassphrase" && (
            <Field label="SSH Passphrase">
              <Input
                type="password"
                value={sshPassphrase.field.value ?? ""}
                placeholder="Private key passphrase"
                onInput={(e: InputEvt) => {
                  sshPassphrase.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
            </Field>
          )}
 */}
          {sshAuthType.field.value === "password" && (
            <>
              <Field label="SSH Password">
                <Input
                  type="password"
                  value={sshPassword.field.value ?? ""}
                  placeholder="SSH Password"
                  onInput={(e: InputEvt) => {
                    sshPassword.field.onChange(e.currentTarget.value);
                    dirty();
                  }}
                />
              </Field>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
