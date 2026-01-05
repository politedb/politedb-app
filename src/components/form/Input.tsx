import { JSX } from "preact";

export function Input(
  props: JSX.HTMLAttributes<HTMLInputElement> & {
    value: string;
    placeholder?: string;
    type?: string;
    error?: boolean;
    left?: any;
    right?: any;
  }
) {
  const { class: classProp, error, left, right, ...rest } = props;

  const base =
    "h-10 w-full rounded-lg border bg-white px-3 text-sm font-medium text-slate-900 outline-none";
  const focus = "focus:ring-2 focus:ring-blue-200/60 focus:border-blue-400";
  const border = error
    ? "border-rose-300 focus:border-rose-400 focus:ring-rose-200/60"
    : "border-slate-300";
  const padding = left ? "pl-10" : "";
  const paddingRight = right ? "pr-12" : "";

  const cls = [
    base,
    focus,
    border,
    padding,
    paddingRight,
    typeof classProp === "string" ? classProp : "",
  ]
    .filter(Boolean)
    .join(" ");

  // If no addons, render normal input
  if (!left && !right) return <input {...(rest as any)} class={cls} />;

  return (
    <div class="relative">
      {left ? (
        <div class="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400">
          {left}
        </div>
      ) : null}

      <input {...(rest as any)} class={cls} />

      {right ? (
        <div class="absolute top-1/2 right-2 -translate-y-1/2">{right}</div>
      ) : null}
    </div>
  );
}
