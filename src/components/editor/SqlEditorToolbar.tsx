import { Button } from "src/components/common/Button";
import { cn } from "src/utils/cn";
import { RunIcon } from "src/components/icons";

type Props = {
  onExport?: () => void;
  onFormat?: () => void;
  onMinify?: () => void;

  onRun: () => void;
  onCancel?: () => void;
  isExecuting: boolean;
  hasSelection: boolean;
};

export function SqlEditorToolbar(props: Props) {
  const {
    onExport,
    onFormat,
    onMinify,
    onRun,
    onCancel,
    isExecuting,
    hasSelection,
  } = props;

  const toolBtn = cn(
    "h-8 px-2 rounded-md text-xs font-medium",
    "text-neutral-700",
    "hover:bg-neutral-100 active:bg-neutral-200",
    "disabled:opacity-40"
  );

  const canCancel = isExecuting && !!onCancel;

  return (
    <div class="flex h-10 items-center border-b border-neutral-200 bg-neutral-50 px-3">
      {/* Left actions */}
      <div class="flex items-center gap-1">
        <Button
          variant="ghost"
          onClick={onExport}
          disabled={!onExport}
          class={toolBtn}
        >
          Export
        </Button>

        <Button
          variant="ghost"
          onClick={onFormat}
          disabled={!onFormat}
          class={toolBtn}
        >
          Format
        </Button>

        <Button
          variant="ghost"
          onClick={onMinify}
          disabled={!onMinify}
          class={toolBtn}
        >
          Minify
        </Button>
      </div>

      {/* Right: Run */}
      <div class="ml-auto flex items-center">
        <button
          type="button"
          onClick={canCancel ? onCancel : onRun}
          disabled={isExecuting && !canCancel}
          title={
            canCancel
              ? "Cancel"
              : hasSelection
                ? "Run Selected (⌘⏎)"
                : "Run Current (⌘⏎)"
          }
          class={cn(
            "inline-flex items-center gap-1.5",
            "h-8 rounded-md px-3",
            "bg-blue-700 text-white",
            "hover:bg-blue-600 active:bg-blue-800",
            "shadow-sm",
            "disabled:opacity-60"
          )}
        >
          <RunIcon class="size-4" />
          <span class="text-xs font-semibold">
            {canCancel
              ? "Cancel"
              : isExecuting
                ? "Running…"
                : hasSelection
                  ? "Run Selected"
                  : "Run Current"}
          </span>
          <span class="ml-1 text-[10px] text-white/70">⌘⏎</span>
        </button>
      </div>
    </div>
  );
}
