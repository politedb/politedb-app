import { cn } from "src/utils/cn";

/** Small "PRO" pill shown next to entry points of Pro-only features. */
export function ProBadge(props: { className?: string }) {
  return (
    <span
      class={cn(
        "inline-flex items-center rounded-full bg-blue-600/10 px-1.5 py-px text-[10px] font-semibold tracking-wide text-blue-600 uppercase",
        props.className
      )}
    >
      Pro
    </span>
  );
}
