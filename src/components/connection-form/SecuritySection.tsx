import { useController } from "react-hook-form";
import { Field } from "src/components/form";
import { Select } from "../common/Select";
import type { SectionProps } from "./connectionForm.utils";

export function SecuritySection(props: SectionProps) {
  const { control, onDirty } = props;

  const storeKeychain = useController({ control, name: "storeKeychain" });

  function dirty() {
    onDirty?.();
  }

  const value = storeKeychain.field.value ? "keychain" : "session";

  return (
    <section class="rounded-2xl border border-slate-200 bg-white p-5">
      <div class="mb-4 text-sm font-semibold text-slate-900">Security</div>

      <Field label="Password storage" alignTop>
        <div>
          <Select
            value={value}
            onChange={(e) => {
              storeKeychain.field.onChange(
                e.currentTarget.value === "keychain"
              );
              dirty();
            }}
          >
            <option value="session">Don’t save (ask every time)</option>
            <option value="keychain">Save securely on Keychain</option>
          </Select>

          <div class="mt-2 text-xs leading-snug text-slate-500">
            {storeKeychain.field.value ? (
              <>
                Password is encrypted and stored in your operating system’s
                secure keychain.
              </>
            ) : (
              <>
                Password is used for this connection only and will not be saved.
              </>
            )}
          </div>
        </div>
      </Field>
    </section>
  );
}
