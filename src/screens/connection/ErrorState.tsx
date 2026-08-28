import { Box } from "src/components/common/Box";
import { DatabaseIcon } from "src/components/icons";
import { cn } from "src/utils/cn";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";

type ErrorStateProps = {
  title?: string;
  message: string;
  hint?: string;
  className?: string;
};

export function ErrorState({
  title = "Execution",
  message,
  hint = "Check connection, permissions, or try a smaller LIMIT.",
  className,
}: ErrorStateProps) {
  return (
    <Box className={cn("bg-neutral-100", className)}>
      <div class="flex h-full w-full items-center justify-center p-6">
        <div class="w-140 max-w-[90vw]">
          <div class="rounded-xl border border-neutral-200 bg-white">
            {/* Header */}
            <div class="flex items-center justify-between gap-4 border-b border-neutral-200 px-4 py-3">
              <div class="flex min-w-0 items-center gap-2">
                <DatabaseIcon className="size-4 text-red-600" />
                <div class="min-w-0 truncate text-[15px] font-semibold text-red-600">
                  {title}
                </div>
              </div>

              <span class="shrink-0 rounded-md bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                ERROR
              </span>
            </div>

            {/* Body */}
            <div class="px-4 py-3">
              <div class="text-[11px] font-semibold text-neutral-500">
                Details
              </div>

              <OverlayScrollArea
                className="mt-2 max-h-44 rounded-lg border border-neutral-200 bg-neutral-50"
                contentClassName="wrap-break-word whitespace-pre-wrap p-3 font-mono text-[12px] leading-5 text-neutral-900"
                horizontal
                vertical
              >
                {message}
              </OverlayScrollArea>

              {hint ? (
                <div class="mt-3 text-xs leading-5 text-neutral-500">
                  {hint}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </Box>
  );
}
