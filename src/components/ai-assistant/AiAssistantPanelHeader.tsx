import { AiAssistantSettingsDialog } from "src/components/ai-assistant/AiAssistantSettingsDialog";
import { SettingsIcon } from "src/components/icons";
import { cn } from "src/utils/cn";

export function AiAssistantPanelHeader(props: {
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
}) {
  const { settingsOpen, onSettingsOpenChange } = props;

  return (
    <div class="shrink-0 border-b border-neutral-200 p-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-sm font-semibold text-neutral-900">AI Assistant</div>
          <div class="mt-1 text-xs text-neutral-500">
            Ask questions, draft SQL, and review database actions.
          </div>
        </div>

        <button
          type="button"
          title="AI settings"
          onClick={() => onSettingsOpenChange(!settingsOpen)}
          class={cn(
            "rounded-md border border-neutral-200 p-1 text-neutral-500 transition-colors hover:bg-neutral-100",
            settingsOpen && "border-blue-200 bg-blue-50 text-blue-700"
          )}
          aria-haspopup="dialog"
        >
          <SettingsIcon className="size-4" />
        </button>
        <AiAssistantSettingsDialog
          open={settingsOpen}
          onClose={() => onSettingsOpenChange(false)}
        />
      </div>
    </div>
  );
}
