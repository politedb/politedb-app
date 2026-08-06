import { Button } from "src/components/common/Button";
import { Spinner } from "src/components/common/Spinner";
import { type AiRuntimeStatus } from "src/lib/tauri";
import { formatBytesSize } from "src/utils/convert";

function isModelDownloading(status?: AiRuntimeStatus | null) {
  const details = status?.last_error?.trim() ?? "";
  return (
    status?.model_downloaded_bytes != null ||
    status?.model_total_bytes != null ||
    /downloading( local)? ai model/i.test(details)
  );
}

export function AiAssistantRuntimeLoadingPane(props: {
  status: AiRuntimeStatus | null;
  onRetry: () => void;
  onCancelDownload: () => void;
  showRetry?: boolean;
  forceDownloading?: boolean;
}) {
  const details = props.status?.last_error?.trim() || "Please wait...";
  const isDownloading =
    props.forceDownloading || isModelDownloading(props.status);
  const downloaded = Number(props.status?.model_downloaded_bytes ?? 0);
  const total = Number(props.status?.model_total_bytes ?? 0);
  const progressPct =
    total > 0 ? Math.max(0, Math.min(100, (downloaded / total) * 100)) : null;

  return (
    <div class="mt-10 flex h-full min-h-0 items-start justify-center px-6 py-8">
      <div class="w-full max-w-sm text-center">
        <div class="mx-auto flex size-12 items-center justify-center rounded-full bg-blue-50">
          <Spinner className="size-5 text-blue-500" />
        </div>

        <div class="mt-4 text-base font-semibold text-neutral-900">
          {isDownloading
            ? "Downloading local AI model"
            : "Preparing AI Assistant"}
        </div>

        <div class="mt-2 text-sm leading-6 text-neutral-500">
          {isDownloading
            ? "PoliteDB is downloading the default model. This may take a while depending on your network."
            : "PoliteDB is starting the AI runtime. The chat will appear as soon as it is ready."}
        </div>

        {isDownloading ? (
          <div class="mt-4">
            <div class="h-2 overflow-hidden rounded-full bg-neutral-100">
              <div
                class="h-full rounded-full bg-blue-600 transition-[width]"
                style={{ width: `${progressPct ?? 0}%` }}
              />
            </div>
            <div class="mt-2 text-xs text-neutral-500">
              {progressPct !== null
                ? `${progressPct.toFixed(1)}%`
                : "Preparing download..."}
              {" · "}
              {formatBytesSize(downloaded, { fractionDigits: 2 })}
              {total > 0
                ? ` / ${formatBytesSize(total, { fractionDigits: 2 })}`
                : ""}
            </div>
          </div>
        ) : null}

        <div class="mt-4 text-xs text-neutral-400">{details}</div>

        {isDownloading ? (
          <div class="mt-5 flex justify-center">
            <Button
              variant="outline"
              class="px-3 py-1.5"
              onClick={props.onCancelDownload}
            >
              Cancel
            </Button>
          </div>
        ) : props.showRetry ? (
          <div class="mt-5 flex justify-center">
            <Button
              variant="outline"
              class="px-3 py-1.5"
              onClick={props.onRetry}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AiAssistantMissingModelPane(props: {
  onDownload: () => void;
  busy: boolean;
}) {
  return (
    <div class="mt-10 flex h-full min-h-0 items-start justify-center px-6 py-8">
      <div class="w-full max-w-sm text-center">
        <div class="mx-auto flex size-12 items-center justify-center rounded-full bg-blue-50 text-sm font-semibold text-blue-600">
          <span class="flex size-6 items-center justify-center rounded-full border-2 border-blue-600/70 font-bold select-none">
            !
          </span>
        </div>

        <div class="mt-4 text-base font-semibold text-neutral-900">
          Missing AI model
        </div>

        <div class="mt-2 text-sm leading-6 text-neutral-500">
          The AI model is missing. Download it to use the AI assistant.
        </div>

        <div class="mt-5 flex justify-center">
          <Button
            class="px-3 py-1.5"
            onClick={props.onDownload}
            loading={props.busy}
          >
            Download model
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AiAssistantMissingRuntimePane(props: {
  details?: string | null;
  onRetry: () => void;
}) {
  return (
    <div class="flex h-full min-h-0 items-start justify-center px-6 py-8">
      <div class="w-full max-w-sm text-center">
        <div class="mx-auto flex size-12 items-center justify-center rounded-full bg-red-50 text-sm font-semibold text-red-600">
          <span class="flex size-6 items-center justify-center rounded-full border-2 border-red-600/70 font-bold select-none">
            !
          </span>
        </div>

        <div class="mt-4 text-base font-semibold text-neutral-900">
          Missing AI runtime
        </div>

        <div class="mt-2 text-sm leading-6 text-neutral-500">
          The bundled AI server binary is not available, so the assistant cannot
          start yet.
        </div>

        {props.details ? (
          <div class="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-left text-xs leading-5 text-red-700">
            {props.details}
          </div>
        ) : null}

        <div class="mt-5 flex justify-center">
          <Button variant="outline" class="px-3 py-1.5" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}
