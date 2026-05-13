import { useEffect, useMemo, useState } from "preact/hooks";
import { Box } from "src/components/common/Box";
import { DatabaseIcon } from "src/components/icons";
import { cn } from "src/utils/cn";

export function LoadingTableState(props: { progress?: number | null }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const elapsedMs = now - startedAt;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const progress =
    typeof props.progress === "number"
      ? Math.max(0, Math.min(99, Math.round(props.progress)))
      : null;

  const { title, subtitle } = useMemo(() => {
    if (elapsedMs < 1200) {
      return {
        title: "Loading table data",
        subtitle: "Fetching rows",
      };
    }

    if (elapsedMs < 4500) {
      return {
        title: "Loading table data",
        subtitle: "Still working",
      };
    }

    if (elapsedMs < 12000) {
      return {
        title: "Taking longer than usual",
        subtitle: "This may take a bit more time",
      };
    }

    return {
      title: "Still loading table data",
      subtitle: "You can cancel the query if needed",
    };
  }, [elapsedMs]);

  return (
    <Box className="bg-neutral-50">
      <div class="flex h-full w-full items-center justify-center">
        <div class="w-120 max-w-[90vw] rounded-xl border border-neutral-200 bg-white px-6 py-6 shadow-sm">
          {/* Row 1: icon + headline */}
          <div class="flex items-center gap-1">
            <DatabaseIcon className="size-4 text-neutral-900" />
            <div class={cn("text-md font-semibold text-neutral-900")}>
              {title}
            </div>
          </div>

          {/* Row 2: subtitle + elapsed */}
          <div class="mt-1 flex items-baseline justify-between gap-4">
            <div class="min-w-0 flex-1 truncate text-sm leading-5 text-neutral-600">
              {subtitle}
            </div>

            <div class="shrink-0 text-xs leading-5 text-neutral-600 tabular-nums">
              {elapsedSec}s elapsed
            </div>
          </div>

          {/* Row 3: loading bar (align with text block, not icon) */}
          <div class="mt-4 flex items-center gap-3">
            <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-200/70">
              {progress === null ? (
                <div class="h-full w-1/3 animate-[indeterminate_1.1s_ease-in-out_infinite] rounded-full bg-blue-600/75" />
              ) : (
                <div
                  class="h-full rounded-full bg-blue-600/85 transition-[width] duration-200 ease-out"
                  style={{ width: `${progress}%` }}
                />
              )}
            </div>
          </div>

          <style>
            {`
              @keyframes indeterminate {
                0%   { transform: translateX(-120%); }
                50%  { transform: translateX(40%); }
                100% { transform: translateX(220%); }
              }
            `}
          </style>
        </div>
      </div>
    </Box>
  );
}
