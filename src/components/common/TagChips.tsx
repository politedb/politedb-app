import { cn } from "src/utils/cn";

function normalizeTags(raw: unknown): string[] {
  const arr: string[] = Array.isArray(raw)
    ? (raw as any[]).map((x) => String(x ?? ""))
    : typeof raw === "string"
      ? [raw]
      : [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const t of arr) {
    const v = String(t ?? "").trim();
    if (!v) continue;

    const key = v.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(v);
  }

  return out;
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

  const chipCls =
    size === "md" ? "px-2.5 py-1 text-[12px]" : "px-2 py-0.5 text-[11px]";

  return (
    <div class={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      {shown.map((t) => (
        <span
          key={t}
          title={t}
          class={cn(
            "max-w-30 truncate rounded-md border border-slate-200 bg-slate-50 font-semibold text-slate-600",
            chipCls
          )}
        >
          {t}
        </span>
      ))}

      {rest > 0 ? (
        <span
          class={cn(
            "rounded-md border border-slate-200 bg-slate-50 font-semibold text-slate-600",
            chipCls
          )}
          title={list.slice(max).join(", ")}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}
