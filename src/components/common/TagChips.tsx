import { cn } from "src/utils/cn";
import { normalizeTags } from "src/utils/convert";

function tagTone(tag: string) {
  const normalized = tag.trim().toLowerCase();

  if (["local"].includes(normalized)) {
    return "border-slate-200 bg-slate-50 text-slate-700";
  }

  if (["dev", "develop", "development"].includes(normalized)) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (["staging", "stage", "stg"].includes(normalized)) {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }

  if (["prod", "production", "live"].includes(normalized)) {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (["upgrade", "trial", "starter"].includes(normalized)) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-neutral-200 bg-white text-neutral-700";
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
        <div
          key={t}
          title={t}
          class={cn("max-w-26 min-w-0", baseCls, chipCls, tagTone(t))}
        >
          <span class="truncate overflow-hidden text-ellipsis">{t}</span>
        </div>
      ))}

      {rest > 0 ? (
        <span
          title={list.slice(max).join(", ")}
          class={cn(
            baseCls,
            chipCls,
            "border-neutral-200 bg-white text-neutral-700"
          )}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}
