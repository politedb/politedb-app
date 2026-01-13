import { Button } from "src/components/common/Button";
import { cn } from "src/utils/cn";
import {
  SaveIcon,
  SaveAsIcon,
  RevertIcon,
  RunIcon,
} from "src/components/icons";

export type SaveStatus = "saved" | "unsaved" | "saving";

type Props = {
  saveStatus: SaveStatus;

  onSave: () => void;
  onSaveAs?: () => void;
  onRevert: () => void;
  canRevert: boolean;

  limitLabel: string;
  onClickLimit?: () => void;

  onBeautify?: () => void;

  onRun: () => void;
  isExecuting: boolean;
  hasSelection: boolean;
};

export function SqlEditorToolbar(props: Props) {
  const {
    saveStatus,
    onSave,
    onSaveAs,
    onRevert,
    canRevert,
    limitLabel,
    onClickLimit,
    onBeautify,
    onRun,
    isExecuting,
    hasSelection,
  } = props;

  const toolIconBtn = cn(
    "inline-flex items-center gap-1 cursor-pointer",
    "h-8 px-2 rounded-md",
    "text-neutral-700",
    "hover:bg-neutral-100 active:bg-neutral-200",
    "disabled:opacity-40"
  );

  const toolTextBtn = cn(
    "h-8 px-2 rounded-md text-xs font-medium",
    "text-neutral-700",
    "hover:bg-neutral-100 active:bg-neutral-200",
    "disabled:opacity-40"
  );

  return (
    <div
      class={cn(
        "flex items-center",
        "h-10 px-3",
        "bg-neutral-50",
        "border-b border-neutral-100"
      )}
    >
      {/* Left: file actions (icon-first, flat) */}
      <div class="flex items-center gap-1">
        <button
          type="button"
          onClick={onSave}
          title="Save (⌘S)"
          class={toolIconBtn}
        >
          <SaveIcon class="size-4 text-neutral-600" />
          <span class="text-xs">Save</span>
          <span class="ml-1 text-[10px] text-neutral-400">⌘S</span>
        </button>

        <button
          type="button"
          onClick={onSaveAs}
          disabled={!onSaveAs}
          title="Save As…"
          class={toolIconBtn}
        >
          <SaveAsIcon class="size-4 text-neutral-600" />
          <span class="text-xs">Save As</span>
        </button>

        <button
          type="button"
          onClick={onRevert}
          disabled={!canRevert || saveStatus === "saving"}
          title="Revert to last saved"
          class={toolIconBtn}
        >
          <RevertIcon class="size-4 text-neutral-600" />
          <span class="text-xs">Revert</span>
        </button>
      </div>

      {/* Right: execution */}
      <div class="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          onClick={onClickLimit}
          disabled={!onClickLimit}
          class={toolTextBtn}
          title="Limit"
        >
          {limitLabel}
        </Button>

        <Button
          variant="ghost"
          onClick={onBeautify}
          disabled={!onBeautify}
          class={toolTextBtn}
          title="Beautify SQL"
        >
          Beautify
        </Button>

        <button
          type="button"
          onClick={onRun}
          disabled={isExecuting}
          title={hasSelection ? "Run Selected (⌘⏎)" : "Run Current (⌘⏎)"}
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
            {isExecuting
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
