import type { ComponentChildren } from "preact";
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

/** An icon with a corner "Pro" pill, for icon-only toolbar buttons of Pro features. */
export function ProIcon(props: { children: ComponentChildren }) {
  return (
    <span class="relative inline-flex">
      {props.children}
      <ProBadge className="pointer-events-none absolute -top-2 -right-3 bg-blue-50 px-1 text-[8px] leading-tight" />
    </span>
  );
}
