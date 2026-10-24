import { Button } from "src/components/common/Button";
import { cn } from "src/utils/cn";
import { PlayIcon, XIcon } from "src/components/icons";
import { formatShortcutLabel } from "src/stores/keyboardShortcuts";

const RUN_SHORTCUT = formatShortcutLabel("Mod+Enter");
const RUN_ALL_SHORTCUT = formatShortcutLabel("Mod+Shift+Enter");

type Props = {
  onExport?: () => void;
  onFormat?: () => void;
  onMinify?: () => void;
  /** Estimated plan; the statement is not run. */
  onExplain?: () => void;
  /**
   * When offered (Pro, PostgreSQL), Explain calls this instead: it measures
   * the plan, or estimates statements that can't be measured.
   */
  onExplainAnalyze?: () => void;

  onRun: () => void;
  /** Runs every statement in the editor. */
  onRunAll?: () => void;
  onCancel?: () => void;
  isExecuting: boolean;
  hasSelection: boolean;
};

export function SqlEditorToolbar(props: Props) {
  const {
    onExport,
    onFormat,
    onMinify,
    onExplain,
    onExplainAnalyze,
    onRun,
    onRunAll,
    onCancel,
    isExecuting,
    hasSelection,
  } = props;

  const toolBtn = cn(
    "px-2 py-1 rounded-md text-xs font-medium",
    "text-neutral-700",
    "hover:bg-neutral-100 active:bg-neutral-200",
    "disabled:opacity-40"
  );

  const canCancel = isExecuting && !!onCancel;

  return (
    <div class="flex h-10 items-center border-y border-neutral-200 bg-neutral-50 px-3">
      {/* Left actions */}
      <div class="flex items-center gap-1">
        <Button
          variant="ghost"
          onClick={onExport}
          disabled={!onExport}
          title="Save the editor's SQL to a .sql file"
          class={toolBtn}
        >
          Save as…
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

        {onExplainAnalyze ? (
          <Button
            variant="ghost"
            onClick={onExplainAnalyze}
            disabled={isExecuting}
            title="Run the statement read-only and show the measured plan. Statements that can't be measured (for example UPDATE) get the estimated plan."
            class={toolBtn}
          >
            Explain
          </Button>
        ) : (
          <Button
            variant="ghost"
            onClick={onExplain}
            disabled={!onExplain || isExecuting}
            class={toolBtn}
          >
            Explain
          </Button>
        )}
      </div>

      {/* Right: Run */}
      <div class="ml-auto flex items-center gap-1">
        {onRunAll && !isExecuting ? (
          <Button
            variant="ghost"
            onClick={onRunAll}
            title={`Run every statement in the editor (${RUN_ALL_SHORTCUT})`}
            class={toolBtn}
          >
            Run All
          </Button>
        ) : null}
        <Button
          variant={canCancel ? "primary" : "default"}
          onClick={canCancel ? onCancel : onRun}
          disabled={isExecuting && !canCancel}
          title={
            canCancel
              ? "Cancel"
              : hasSelection
                ? `Run the selected SQL (${RUN_SHORTCUT})`
                : `Run the statement at the cursor (${RUN_SHORTCUT})`
          }
          class={cn("py-1.5 disabled:opacity-60")}
        >
          {canCancel ? (
            <XIcon className="size-4" />
          ) : (
            <PlayIcon class="size-4" />
          )}
          <span class="text-xs font-semibold">
            {canCancel
              ? "Cancel"
              : isExecuting
                ? "Running…"
                : hasSelection
                  ? "Run Selected"
                  : "Run Current"}
          </span>
          {canCancel ? null : (
            <span class="ml-1 text-[10px] text-white/70">{RUN_SHORTCUT}</span>
          )}
        </Button>
      </div>
    </div>
  );
}
