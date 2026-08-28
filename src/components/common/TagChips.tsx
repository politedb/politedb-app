import { cn } from "src/utils/cn";
import { normalizeTags } from "src/utils/convert";

function tagTone(tag: string) {
  const normalized = tag.trim().toLowerCase();

  if (normalized === "local") {
    return "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }

  if (normalized === "dev" || normalized === "development") {
    return "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-300";
  }

  if (normalized === "staging" || normalized === "stage") {
    return "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/40 dark:bg-sky-950/40 dark:text-sky-300";
  }

  if (
    normalized === "prod" ||
    normalized === "production" ||
    normalized === "live"
  ) {
    return "border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-500/40 dark:bg-rose-950/40 dark:text-rose-300";
  }

  if (
    normalized === "upgrade" ||
    normalized === "trial" ||
    normalized === "starter"
  ) {
    return "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-300";
  }

  return "border-neutral-200 bg-white text-neutral-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
}

export function TagChips(props: {
  tags?: string[] | string | null;
  max?: number; // default 3
  size?: "sm" | "md"; // default "sm"
  className?: string;
}) {
  const { tags, max = 3, size = "sm", className } = props;

  const list = normalizeTags(tags);
  if (!list.length) return null;

  const shown = list.slice(0, max);
  const rest = list.length - shown.length;

  const chipCls = size === "md" ? "h-6 px-2.5 text-xs" : "h-5 px-2 text-xs";

  const baseCls =
    "flex items-center justify-center rounded-md border font-semibold shadow-[0_1px_0_rgba(0,0,0,0.02)]";

  return (
    <div class={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {shown.map((t) => (
        <span
          key={t}
          title={t}
          class={cn("max-w-30 min-w-0 truncate", baseCls, chipCls, tagTone(t))}
        >
          {t}
        </span>
      ))}

      {rest > 0 ? (
        <span
          title={list.slice(max).join(", ")}
          class={cn(
            baseCls,
            chipCls,
            "border-neutral-200 bg-white text-neutral-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
          )}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}
