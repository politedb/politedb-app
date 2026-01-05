import { TargetedEvent } from "preact";
import { useController } from "react-hook-form";
import { Field, Input } from "src/components/form";
import { Button } from "../common/Button";
import type { SectionProps } from "./connectionForm.utils";

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
  const sshKeyPath = useController({ control, name: "sshKeyPath" });

  function dirty() {
    onDirty?.();
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
          <Field label="SSH Host / Port" alignTop>
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

          <Field label="SSH User / Key" alignTop>
            <div class="grid grid-cols-2 gap-3">
              <Input
                value={sshUser.field.value}
                placeholder="ubuntu"
                onInput={(e: InputEvt) => {
                  sshUser.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
              <Input
                value={sshKeyPath.field.value}
                placeholder="~/.ssh/id_ed25519"
                onInput={(e: InputEvt) => {
                  sshKeyPath.field.onChange(e.currentTarget.value);
                  dirty();
                }}
              />
            </div>
          </Field>
        </div>
      ) : null}
    </section>
  );
}
