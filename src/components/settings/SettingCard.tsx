import { cn } from "src/utils/cn";

export function SettingCard(props: {
  title?: string;
  class?: string;
  children: preact.ComponentChildren;
}) {
  return (
    <section
      class={cn(
        "rounded-xl border border-slate-200 bg-white shadow-sm",
        props.class
      )}
    >
      {props.title && (
        <h3 class="text-sm font-semibold text-slate-900">{props.title}</h3>
      )}
      <div class={cn(props.title && "mt-3")}>{props.children}</div>
    </section>
  );
}
