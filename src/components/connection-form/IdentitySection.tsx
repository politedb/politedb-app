import { useController } from "react-hook-form";
import { Field } from "src/components/form";
import { TagInput } from "../common/TagInput";
import { ColorPicker } from "../common/ColorPicker";
import type { SectionProps } from "./connectionForm.utils";

const TAG_SUGGESTIONS = ["dev", "staging", "prod", "read"];

export function IdentitySection(props: SectionProps) {
  const { control, onDirty } = props;

  const tags = useController({ control, name: "tags" });
  const indicatorColor = useController({ control, name: "indicator_color" });

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
            placeholder="local, dev, prod…"
            suggestions={TAG_SUGGESTIONS}
            onChange={(next) => {
              tags.field.onChange(next);
              dirty();
            }}
          />
        </Field>

        <Field label="Indicator color" alignTop>
          <div class="space-y-1">
            <ColorPicker
              value={indicatorColor.field.value}
              onChange={(c) => {
                indicatorColor.field.onChange(c);
                dirty();
              }}
            />
            <div class="text-xs text-slate-500">
              Used as a subtle background accent on hover.
            </div>
          </div>
        </Field>
      </div>
    </section>
  );
}
