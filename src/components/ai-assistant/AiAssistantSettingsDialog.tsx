import { useEffect, useMemo, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import {
  DownloadIcon,
  PlayIcon,
  RefreshCwIcon,
  StopIcon,
  VaultIcon,
} from "src/components/icons";
import type { AiRuntimeStatus } from "src/lib/tauri";
import type { AiProviderConfig } from "src/types";
import {
  DEFAULT_LOCAL_AI_PROVIDER_ID,
  DEFAULT_MODELS,
  aiProviderList,
  aiProviderTest,
  buildBaseUrl,
  makeDefaultAiProvider,
  normalizeAiProviderConfig,
  saveAiProviderWithOptionalKey,
  setSelectedAiProviderId,
} from "@root/src/lib/ai-assistant/providers";
import { normalizeLocalAiModelName } from "src/utils/assistant";

type Props = {
  open: boolean;
  onClose: () => void;
  loadingModels: boolean;
  runtimeBusy: boolean;
  runtimeStatus: AiRuntimeStatus | null;
  onLoadModels: () => void;
  onStartRuntime: () => void;
  onStopRuntime: () => void;
  onDownloadModel: () => void;
};

const LOCAL_PROVIDER_KIND = "ollama";
const MODEL_VARIANT = "PoliteDB AI • Q4_K_M";

function runtimeLabel(phase?: string) {
  if (phase === "ready") return "Ready";
  if (phase === "starting") return "Starting";
  if (phase === "missing") return "Missing";
  if (phase === "error") return "Error";
  return "Stopped";
}

function modelInstallLabel(status: AiRuntimeStatus | null) {
  if (status?.model_path) return "Installed";
  if (status?.missing?.some((item) => item.toLowerCase().includes("gguf"))) {
    return "Missing";
  }
  return "Unknown";
}

function formatBytes(value?: number | null) {
  if (value == null || Number.isNaN(value)) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  return `${next.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function shortPath(path?: string | null) {
  if (!path) return "Not installed";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 4 ? `${parts.slice(-4).join("/")}` : path;
}

function splitEndpoint(endpoint?: string | null) {
  const fallback = {
    host: "http://127.0.0.1:11434",
    subPath: "/v1",
  };
  if (!endpoint?.trim()) return fallback;

  try {
    const url = new URL(endpoint);
    return {
      host: `${url.protocol}//${url.host}`,
      subPath: url.pathname && url.pathname !== "/" ? url.pathname : "/v1",
    };
  } catch {
    return fallback;
  }
}

export function AiAssistantSettingsDialog(props: Props) {
  const {
    open,
    onClose,
    loadingModels,
    runtimeBusy,
    runtimeStatus,
    onLoadModels,
    onStartRuntime,
    onStopRuntime,
    onDownloadModel,
  } = props;

  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [label, setLabel] = useState("PoliteDB AI");
  const [host, setHost] = useState("http://127.0.0.1:11434");
  const [subPath, setSubPath] = useState("/v1");
  const [model, setModel] = useState(DEFAULT_MODELS.ollama);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const normalizedProviders = useMemo(
    () => providers.map(normalizeAiProviderConfig),
    [providers]
  );
  const localProvider = normalizedProviders.find(
    (provider) => provider.id === DEFAULT_LOCAL_AI_PROVIDER_ID
  );

  const loadProviders = async () => {
    const next = await aiProviderList().catch(() => []);
    setProviders(next.map(normalizeAiProviderConfig));
  };

  useEffect(() => {
    if (open) void loadProviders();
  }, [open]);

  useEffect(() => {
    const endpointParts = splitEndpoint(runtimeStatus?.endpoint);
    setLabel(localProvider?.label ?? "PoliteDB AI");
    setHost(localProvider?.host ?? endpointParts.host);
    setSubPath(localProvider?.subPath ?? endpointParts.subPath);
    setModel(normalizeLocalAiModelName(localProvider?.defaultModel));
    setStatus("");
  }, [localProvider, runtimeStatus?.endpoint]);

  const saveProvider = async (
    message = "Saved local AI settings.",
    overrides: { label?: string; model?: string } = {}
  ) => {
    setBusy(true);
    setStatus("");
    try {
      const nextLabel = overrides.label ?? label;
      const nextModel = overrides.model ?? model;
      const config = makeDefaultAiProvider(LOCAL_PROVIDER_KIND, {
        id: localProvider?.id ?? DEFAULT_LOCAL_AI_PROVIDER_ID,
        label: nextLabel.trim() || "PoliteDB AI",
        host,
        subPath,
        baseUrl: buildBaseUrl(host, subPath),
        defaultModel: normalizeLocalAiModelName(nextModel),
        enabled: true,
        isDefault: true,
      });
      const saved = await saveAiProviderWithOptionalKey({ config });
      setSelectedAiProviderId(saved.id);
      await loadProviders();
      setStatus(message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const testProvider = async () => {
    const provider = localProvider;
    if (!provider) {
      await saveProvider("Saved local AI settings. Run test again.");
      return;
    }
    setBusy(true);
    setStatus("Testing local model...");
    try {
      const startedAt = performance.now();
      await aiProviderTest(provider.id);
      setSelectedAiProviderId(provider.id);
      const latency = Math.max(1, Math.round(performance.now() - startedAt));
      setStatus(`Local model test succeeded in ${latency} ms.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resetLocalSettings = async () => {
    const ok = window.confirm(
      "Reset local AI settings to the bundled Qwen model?"
    );
    if (!ok) return;
    setLabel("PoliteDB AI");
    setModel(DEFAULT_MODELS.ollama);
    await saveProvider("Reset local AI settings.", {
      label: "PoliteDB AI",
      model: DEFAULT_MODELS.ollama,
    });
  };

  const handleDownloadModel = () => {
    const installed = Boolean(runtimeStatus?.model_path);
    const ok = window.confirm(
      installed
        ? "Re-download the local AI model? This may take a while."
        : "Download the local AI model? This may take a while."
    );
    if (ok) onDownloadModel();
  };

  const runtimePhase = runtimeStatus?.phase;
  const runtimeReady = runtimePhase === "ready";
  const modelInstalled = Boolean(runtimeStatus?.model_path);
  const modelSize =
    runtimeStatus?.model_total_bytes ??
    (modelInstalled ? 4.33 * 1024 ** 3 : null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      className="max-w-3xl overflow-hidden"
    >
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle>AI Assistant Settings</DialogTitle>
      </DialogHeader>
      <DialogContent className="min-h-0 overflow-y-auto p-5">
        <div class="space-y-5">
          <section class="rounded-xl border border-neutral-200 bg-white p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="flex min-w-0 items-start gap-3">
                <div class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
                  <VaultIcon className="size-5" />
                </div>
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-neutral-950">
                    Qwen2.5-Coder-7B
                  </div>
                  <div class="mt-1 text-xs text-neutral-500">
                    {MODEL_VARIANT}
                  </div>
                </div>
              </div>
              <span class="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-xs font-semibold text-neutral-700">
                {modelInstallLabel(runtimeStatus)}
              </span>
            </div>

            <div class="mt-4 grid gap-3 sm:grid-cols-2">
              <Input
                label="Name"
                value={label}
                onValueChange={setLabel}
                className="h-10 border border-neutral-300 px-3 text-sm focus:border-blue-500"
              />
              <Input
                label="Model"
                value={normalizeLocalAiModelName(model)}
                readOnly
                className="h-10 border border-neutral-300 bg-neutral-50 px-3 text-sm text-neutral-700"
              />
            </div>
          </section>

          <section class="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
            <div class="mb-3 flex items-center justify-between gap-2">
              <div>
                <div class="text-sm font-semibold text-neutral-950">
                  Local Runtime
                </div>
                <div class="mt-1 text-xs text-neutral-500">
                  Bundled llama-server running on this device.
                </div>
              </div>
              <div class="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs font-semibold text-neutral-700">
                {runtimeLabel(runtimePhase)}
              </div>
            </div>

            <div class="grid gap-2 rounded-lg border border-neutral-200 bg-white p-3 text-xs">
              <InfoRow
                label="Endpoint"
                value={runtimeStatus?.endpoint ?? "-"}
              />
              <InfoRow label="PID" value={runtimeStatus?.pid ?? "-"} />
              <InfoRow label="Model size" value={formatBytes(modelSize)} />
              <InfoRow
                label="Model path"
                value={shortPath(runtimeStatus?.model_path)}
                title={runtimeStatus?.model_path ?? undefined}
              />
              {runtimeStatus?.last_error ? (
                <InfoRow
                  label="Status detail"
                  value={runtimeStatus.last_error}
                />
              ) : null}
            </div>

            <div class="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant={runtimeReady ? "destructive" : "default"}
                class="px-3 py-1"
                onClick={runtimeReady ? onStopRuntime : onStartRuntime}
                loading={runtimeBusy}
              >
                {runtimeReady ? (
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
                class="px-3 py-1"
                onClick={onLoadModels}
                loading={loadingModels}
              >
                <RefreshCwIcon className="size-3.5" />
                Refresh
              </Button>
              <Button
                variant="outline"
                class="px-3 py-1"
                onClick={handleDownloadModel}
                disabled={runtimeBusy || runtimeReady}
              >
                <DownloadIcon className="size-3.5" />
                {modelInstalled ? "Re-download model" : "Download model"}
              </Button>
            </div>
          </section>

          {status ? (
            <div class="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
              {status}
            </div>
          ) : null}

          <div class="flex items-center justify-between gap-2 border-t border-neutral-200 pt-4">
            <Button
              variant="outline"
              class="px-3 py-1"
              onClick={() => void resetLocalSettings()}
              disabled={busy}
            >
              Reset settings
            </Button>
            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                class="px-3 py-1"
                onClick={() => void testProvider()}
                disabled={busy || runtimePhase !== "ready"}
              >
                Test model
              </Button>
              <Button
                variant="default"
                class="px-4 py-1"
                loading={busy}
                onClick={() => void saveProvider()}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow(props: {
  label: string;
  value: string | number;
  title?: string;
}) {
  return (
    <div class="grid grid-cols-[120px_1fr] gap-3">
      <div class="text-neutral-400">{props.label}</div>
      <div
        class="min-w-0 truncate font-medium text-neutral-700"
        title={props.title}
      >
        {props.value}
      </div>
    </div>
  );
}
