import { cn } from "src/utils/cn";

export function SettingCard(props: {
  title?: string;
  class?: string;
  children: preact.ComponentChildren;
}) {
  return (
    <section
      class={cn(
        "rounded-xl border border-slate-200 bg-white p-4 shadow-sm",
        props.class
      )}
    >
      {props.title && (
        <h3 class="text-sm font-semibold text-slate-900">{props.title}</h3>
      )}
      <div class={cn("space-y-1", props.title && "mt-3")}>{props.children}</div>
    </section>
  );
}
