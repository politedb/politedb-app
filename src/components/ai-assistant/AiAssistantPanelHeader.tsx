import { AiAssistantSettingsPopover } from "src/components/ai-assistant/AiAssistantSettingsPopover";
import { Popover } from "src/components/common/Popover";
import { SettingsIcon } from "src/components/icons";
import { type AiRuntimeStatus } from "src/lib/tauri";
import { cn } from "src/utils/cn";

export function AiAssistantPanelHeader(props: {
  showSettings: boolean;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  loadingModels: boolean;
  runtimeBusy: boolean;
  runtimeStatus: AiRuntimeStatus | null;
  onLoadModels: () => void;
  onStartRuntime: () => void;
  onStopRuntime: () => void;
}) {
  const {
    showSettings,
    settingsOpen,
    onSettingsOpenChange,
    loadingModels,
    runtimeBusy,
    runtimeStatus,
    onLoadModels,
    onStartRuntime,
    onStopRuntime,
  } = props;

  return (
    <div class="shrink-0 border-b border-neutral-200 p-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-sm font-semibold text-neutral-900">AI Assistant</div>
          <div class="mt-1 text-xs text-neutral-500">
            Chat with local model to ask data or get SQL suggestions.
          </div>
        </div>

        {showSettings ? (
          <Popover
            open={settingsOpen}
            onOpenChange={onSettingsOpenChange}
            positions={["bottom"]}
            align="end"
            padding={10}
            contentClassName="rounded-2xl"
            showArrow={false}
            content={
              <AiAssistantSettingsPopover
                loadingModels={loadingModels}
                runtimeBusy={runtimeBusy}
                runtimeStatus={runtimeStatus}
                onLoadModels={onLoadModels}
                onStartRuntime={onStartRuntime}
                onStopRuntime={onStopRuntime}
              />
            }
          >
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
          </Popover>
        ) : null}
      </div>
    </div>
  );
}
