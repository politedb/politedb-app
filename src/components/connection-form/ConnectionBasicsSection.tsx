import { TargetedEvent } from "preact";
import { useMemo, useState } from "preact/hooks";
import { useController, useWatch } from "react-hook-form";
import { Field, Input } from "src/components/form";
import { toNumber } from "src/utils/convert";
import { SSLSection } from "./SSLSection";
import type { SectionProps } from "./connectionForm.utils";

type InputEvt = TargetedEvent<HTMLInputElement>;

export function ConnectionBasicsSection(
  props: SectionProps & { isCreateNewConnection: boolean }
) {
  const { control, errors, onDirty, isCreateNewConnection } = props;

  const storeKeychain = useWatch({ control, name: "storeKeychain" });

  const name = useController({ control, name: "name" });
  const host = useController({ control, name: "host" });
  const port = useController({ control, name: "port" });
  const database = useController({ control, name: "database" });
  const user = useController({ control, name: "user" });
  const password = useController({ control, name: "password" });

  const sslMode = useController({ control, name: "sslMode" });
  const sslKey = useController({ control, name: "sslKey" });
  const sslCert = useController({ control, name: "sslCert" });
  const sslCA = useController({ control, name: "sslCA" });

  const [showPassword, setShowPassword] = useState(false);
  const [showTogglePassword, setShowTogglePassword] = useState(
    !!password.field.value
  );
  const [editingPassword, setEditingPassword] = useState(isCreateNewConnection);

  function dirty() {
    onDirty?.();
  }

  const passwordError =
    !storeKeychain && errors?.password
      ? String(errors.password.message || "Password is required.")
      : undefined;

  // Keychain saved => form value is empty AND user is not editing a new password
  const shouldShowMasked = useMemo(() => {
    const v = String(password.field.value ?? "");
    return !!storeKeychain && v.length === 0 && !editingPassword;
  }, [storeKeychain, password.field.value, editingPassword]);

  return (
    <section class="rounded-2xl border border-slate-200 bg-white p-5">
      <div class="mb-4 flex items-center justify-between">
        <div class="text-sm font-semibold text-slate-900">
          Connection basics
        </div>
        <div class="text-xs text-slate-500">Host, Port, User, Database</div>
      </div>

      <div class="space-y-4">
        <Field label="Name">
          <Input
            value={name.field.value}
            placeholder="Mochi"
            onInput={(e: InputEvt) => {
              name.field.onChange(e.currentTarget.value);
              dirty();
            }}
          />
        </Field>

        <Field label="Host / Port" alignTop>
          <div class="grid grid-cols-3 gap-3">
            <Input
              class="col-span-2"
              value={host.field.value}
              placeholder="127.0.0.1 or /tmp/..."
              onInput={(e: InputEvt) => {
                host.field.onChange(e.currentTarget.value);
                dirty();
              }}
            />
            <Input
              value={String(port.field.value ?? "")}
              inputMode="numeric"
              placeholder="5432"
              onInput={(e: InputEvt) => {
                port.field.onChange(toNumber(e.currentTarget.value, 5432));
                dirty();
              }}
            />
          </div>
        </Field>

        <Field label="Database / User" alignTop>
          <div class="grid grid-cols-2 gap-3">
            <Input
              value={database.field.value}
              placeholder="database"
              onInput={(e: InputEvt) => {
                database.field.onChange(e.currentTarget.value);
                dirty();
              }}
            />
            <Input
              value={user.field.value}
              placeholder="user"
              onInput={(e: InputEvt) => {
                user.field.onChange(e.currentTarget.value);
                dirty();
              }}
            />
          </div>
        </Field>

        <Field label="Password" alignTop>
          <div>
            {shouldShowMasked ? (
              <div class="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-slate-700">
                    ••••••••
                  </span>
                  <span class="text-xs text-slate-500">Saved in Keychain</span>
                </div>

                <button
                  type="button"
                  class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  title="Replace password"
                  onClick={() => {
                    setEditingPassword(true);
                    setShowPassword(false);
                    // keep password value empty; user will type a new one
                    dirty();
                  }}
                >
                  Replace
                </button>
              </div>
            ) : (
              <>
                <div class="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password.field.value}
                    placeholder={
                      storeKeychain
                        ? "Enter password (save in Keychain)"
                        : "Enter password (not saved)"
                    }
                    onInput={(e: InputEvt) => {
                      const next = e.currentTarget.value;
                      password.field.onChange(next);

                      setShowTogglePassword(!!next);
                    }}
                    class="pr-12"
                  />

                  {showTogglePassword && (
                    <button
                      type="button"
                      onClick={() => setShowPassword((x) => !x)}
                      class="absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                      title={showPassword ? "Hide" : "Show"}
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  )}
                </div>

                {/* {storeKeychain && !password.field.value && editingPassword ? (
                  <div class="mt-2 text-xs text-slate-500">
                    Leave empty to keep the existing password.
                    <button
                      type="button"
                      class="ml-2 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500"
                      onClick={() => {
                        // user cancels replacement, go back to masked state
                        password.field.onChange("");
                        setEditingPassword(false);
                        setShowPassword(false);
                        dirty();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : null} */}

                {!storeKeychain && passwordError ? (
                  <div class="mt-2 text-xs text-rose-600">{passwordError}</div>
                ) : null}
              </>
            )}
          </div>
        </Field>

        <SSLSection
          sslMode={sslMode.field.value}
          sslKey={sslKey.field.value}
          sslCert={sslCert.field.value}
          sslCA={sslCA.field.value}
          onChangeSslMode={(m) => {
            sslMode.field.onChange(m);
            dirty();
          }}
          onChangeSslKey={(v) => {
            sslKey.field.onChange(v);
            dirty();
          }}
          onChangeSslCert={(v) => {
            sslCert.field.onChange(v);
            dirty();
          }}
          onChangeSslCA={(v) => {
            sslCA.field.onChange(v);
            dirty();
          }}
        />
      </div>
    </section>
  );
}
