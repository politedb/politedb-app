import { Button } from "src/components/common/Button";
import { PlayIcon, RefreshCwIcon, StopIcon } from "src/components/icons";
import type { AiRuntimeStatus } from "src/lib/tauri";
import { cn } from "src/utils/cn";

type Props = {
  loadingModels: boolean;
  runtimeBusy: boolean;
  runtimeStatus: AiRuntimeStatus | null;
  onLoadModels: () => void;
  onStartRuntime: () => void;
  onStopRuntime: () => void;
};

function getStatusMeta(phase?: string) {
  switch (phase) {
    case "ready":
      return {
        label: "Ready",
        tone: "text-green-700 bg-green-50 border-green-200",
        description: "Local AI is running and ready to answer.",
      };
    case "starting":
      return {
        label: "Starting",
        tone: "text-amber-700 bg-amber-50 border-amber-200",
        description: "Local AI is starting in the background.",
      };
    case "missing":
      return {
        label: "Missing",
        tone: "text-red-700 bg-red-50 border-red-200",
        description: "Model or runtime assets are missing.",
      };
    case "error":
      return {
        label: "Error",
        tone: "text-red-700 bg-red-50 border-red-200",
        description: "Local AI could not start properly.",
      };
    default:
      return {
        label: "Stopped",
        tone: "text-neutral-700 bg-neutral-50 border-neutral-200",
        description: "Local AI is not running yet.",
      };
  }
}

export function AiAssistantSettingsPopover({
  loadingModels,
  runtimeBusy,
  runtimeStatus,
  onLoadModels,
  onStartRuntime,
  onStopRuntime,
}: Props) {
  const statusMeta = getStatusMeta(runtimeStatus?.phase);

  return (
    <div class="w-64 rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
      <div class="flex items-center justify-between gap-2">
        <div class="text-sm font-semibold text-neutral-900">
          AI Assistant Settings
        </div>
        <div
          class={cn(
            "rounded-full border px-2 py-1 text-xs font-semibold",
            statusMeta.tone
          )}
        >
          {statusMeta.label}
        </div>
      </div>

      <div class="mt-1 text-xs leading-5 text-neutral-500">
        {statusMeta.description}
      </div>

      <div class="mt-2 flex items-center gap-2">
        <Button
          variant={runtimeStatus?.phase === "ready" ? "destructive" : "default"}
          class={cn(
            "border border-red-500 px-2 py-1",
            (runtimeBusy || runtimeStatus?.phase !== "ready") &&
              "border-blue-500"
          )}
          onClick={
            runtimeStatus?.phase === "ready" ? onStopRuntime : onStartRuntime
          }
          loading={runtimeBusy}
        >
          {runtimeStatus?.phase === "ready" ? (
            <>
              <StopIcon className="size-3.5" />
              Stop
            </>
          ) : (
            <>
              <PlayIcon className="size-3.5" />
              Start
            </>
          )}
        </Button>

        <Button
          variant="outline"
          class="px-2 py-1"
          onClick={onLoadModels}
          loading={loadingModels}
        >
          <RefreshCwIcon className="size-3.5" />
          Refresh
        </Button>
      </div>

      {runtimeStatus?.last_error ? (
        <div class="mt-3 rounded-lg border border-red-200 bg-red-50 px-2 py-2 text-xs leading-5 text-red-700">
          {runtimeStatus.last_error}
        </div>
      ) : null}
    </div>
  );
}
