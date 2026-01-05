import { cn } from "src/utils/cn";

function normalizeTag(s: string) {
  return s.trim();
}

export function ConnectionPreview(props: {
  name?: string;
  /** ✅ new */
  tags?: string[];
  /** (optional) keep backward compat if you still pass tag somewhere */
  tag?: string;
  color?: string;
}) {
  const { name = "Unnamed connection", color } = props;

  // Backward compatible: if tags not provided, fallback to single tag.
  const tags =
    props.tags?.filter(Boolean).map(normalizeTag) ??
    (props.tag ? [props.tag] : []);

  const shown = tags.slice(0, 3);
  const extra = tags.length - shown.length;

  return (
    <div
      class={cn(
        "flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
      )}
    >
      {/* Indicator */}
      <span
        class="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color || "#CBD5E1" }}
      />

      {/* Label */}
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold text-slate-900">{name}</div>

        {tags.length ? (
          <div class="mt-1 flex flex-wrap items-center gap-1">
            {shown.map((t) => (
              <span
                key={t}
                class="max-w-35 truncate rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600"
                title={t}
              >
                {t}
              </span>
            ))}

            {extra > 0 ? (
              <span
                class="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500"
                title={tags.join(", ")}
              >
                +{extra}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
