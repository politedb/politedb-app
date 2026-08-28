import type { ComponentChildren } from "preact";
import { cn } from "src/utils/cn";

export function FieldRow(props: {
  label: string;
  description?: string;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <div
      class={cn(
        "flex gap-3 border-b border-slate-100 p-4 last:border-b-0 last:pb-0 sm:items-center",
        props.class
      )}
    >
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium text-slate-800">{props.label}</div>
        {props.description ? (
          <div class="mt-0.5 text-xs leading-5 text-slate-500">
            {props.description}
          </div>
        ) : null}
      </div>
      <div>{props.children}</div>
    </div>
  );
}
