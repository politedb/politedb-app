import { useController } from "react-hook-form";
import { Field } from "src/components/form";
import { TagInput } from "../common/TagInput";
import { ColorPicker } from "../common/ColorPicker";
import { ConnectionPreview } from "./ConnectionPreview";
import type { SectionProps } from "./connectionForm.utils";

const TAG_SUGGESTIONS = ["dev", "staging", "prod", "read", "write"];

export function IdentitySection(props: SectionProps) {
  const { control, onDirty } = props;

  const name = useController({ control, name: "name" });
  const tags = useController({ control, name: "tags" });
  const statusColor = useController({ control, name: "statusColor" });

  function dirty() {
    onDirty?.();
  }

  return (
    <section class="rounded-2xl border border-slate-200 bg-white p-5">
      <div class="mb-4 text-sm font-semibold text-slate-900">Identity</div>

      <div class="space-y-4">
        <Field label="Tags" alignTop>
          <TagInput
            value={tags.field.value || []}
            suggestions={TAG_SUGGESTIONS}
            placeholder="local, dev, prod…"
            onChange={(next) => {
              tags.field.onChange(next);
              dirty();
            }}
          />
        </Field>

        <Field label="Indicator color" alignTop>
          <div class="space-y-1">
            <ColorPicker
              value={statusColor.field.value}
              onChange={(c) => {
                statusColor.field.onChange(c);
                dirty();
              }}
            />
            <div class="text-xs text-slate-500">Used in sidebar and tabs.</div>
          </div>
        </Field>

        <div class="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-sm">
          <div class="mb-1 text-xs font-semibold text-slate-500">Preview</div>
          <ConnectionPreview
            name={name.field.value}
            tags={tags.field.value || []}
            color={statusColor.field.value}
          />
        </div>
      </div>
    </section>
  );
}
