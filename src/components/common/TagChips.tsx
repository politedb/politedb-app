import { cn } from "src/utils/cn";
import { normalizeTags } from "src/utils/convert";

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

  const baseCls = cn(
    "flex items-center justify-center rounded-md border",
    "border-neutral-200 bg-white",
    "font-semibold text-neutral-700",
    "shadow-[0_1px_0_rgba(0,0,0,0.02)]"
  );

  return (
    <div class={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {shown.map((t) => (
        <span
          key={t}
          title={t}
          class={cn("max-w-30 truncate", baseCls, chipCls)}
        >
          {t}
        </span>
      ))}

      {rest > 0 ? (
        <span title={list.slice(max).join(", ")} class={cn(baseCls, chipCls)}>
          +{rest}
        </span>
      ) : null}
    </div>
  );
}
