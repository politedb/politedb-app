import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { PlayIcon, RefreshCwIcon, StopIcon } from "src/components/icons";
import type { AiRuntimeStatus } from "src/lib/tauri";
import { cn } from "src/utils/cn";
import type { AiProviderConfig, AiProviderKind } from "src/types";
import {
  AI_PROVIDER_LABELS,
  DEFAULT_MODELS,
  aiProviderList,
  aiProviderTest,
  makeDefaultAiProvider,
  saveAiProviderWithOptionalKey,
  setSelectedAiProviderId,
} from "src/lib/aiProviders";

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
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [kind, setKind] = useState<AiProviderKind>("openai");
  const [label, setLabel] = useState(AI_PROVIDER_LABELS.openai);
  const [model, setModel] = useState(DEFAULT_MODELS.openai);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [providerStatus, setProviderStatus] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);

  const providerKinds = useMemo(
    () => Object.keys(AI_PROVIDER_LABELS) as AiProviderKind[],
    []
  );

  const loadProviders = async () => {
    const next = await aiProviderList().catch(() => []);
    setProviders(next);
  };

  useEffect(() => {
    void loadProviders();
  }, []);

  const changeKind = (next: AiProviderKind) => {
    setKind(next);
    setLabel(AI_PROVIDER_LABELS[next]);
    setModel(DEFAULT_MODELS[next]);
    setBaseUrl("");
    setApiKey("");
    setProviderStatus("");
  };

  const saveProvider = async () => {
    setSavingProvider(true);
    setProviderStatus("");
    try {
      const config = makeDefaultAiProvider(kind, {
        label,
        defaultModel: model,
        baseUrl: baseUrl.trim() || null,
      });
      const saved = await saveAiProviderWithOptionalKey({ config, apiKey });
      setSelectedAiProviderId(saved.id);
      await loadProviders();
      setProviderStatus(`Saved ${saved.label}.`);
    } catch (error) {
      setProviderStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingProvider(false);
    }
  };

  const testProvider = async (providerId: string) => {
    setProviderStatus("Testing provider...");
    try {
      await aiProviderTest(providerId);
      setSelectedAiProviderId(providerId);
      setProviderStatus("Provider test succeeded.");
    } catch (error) {
      setProviderStatus(error instanceof Error ? error.message : String(error));
    }
  };

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

      <div class="mt-3 border-t border-neutral-200 pt-3">
        <div class="text-sm font-semibold text-neutral-900">AI Providers</div>
        <div class="mt-1 text-xs leading-5 text-neutral-500">
          API keys are saved in the OS keychain. The renderer only stores
          provider metadata.
        </div>

        <div class="mt-2 space-y-2">
          <select
            value={kind}
            onChange={(e) =>
              changeKind(e.currentTarget.value as AiProviderKind)
            }
            class="h-8 w-full rounded-md border border-neutral-200 bg-white px-2 text-xs!"
          >
            {providerKinds.map((item) => (
              <option key={item} value={item}>
                {AI_PROVIDER_LABELS[item]}
              </option>
            ))}
          </select>
          <input
            value={model}
            onInput={(e) => setModel(e.currentTarget.value)}
            placeholder="Default model"
            class="h-8 w-full rounded-md border border-neutral-200 px-2 text-xs outline-none focus:border-blue-500"
          />
          <input
            value={baseUrl}
            onInput={(e) => setBaseUrl(e.currentTarget.value)}
            placeholder="Base URL (optional)"
            class="h-8 w-full rounded-md border border-neutral-200 px-2 text-xs outline-none focus:border-blue-500"
          />
          {kind !== "local_openai_compatible" ? (
            <input
              value={apiKey}
              onInput={(e) => setApiKey(e.currentTarget.value)}
              placeholder="API key"
              type="password"
              class="h-8 w-full rounded-md border border-neutral-200 px-2 text-xs outline-none focus:border-blue-500"
            />
          ) : null}
          <Button
            variant="default"
            class="w-full px-2 py-1"
            loading={savingProvider}
            onClick={() => void saveProvider()}
          >
            Save provider
          </Button>
        </div>

        {providers.length ? (
          <div class="mt-3 space-y-1">
            {providers.map((provider) => (
              <div
                key={provider.id}
                class="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-2 py-1"
              >
                <div class="min-w-0">
                  <div class="truncate text-xs font-semibold text-neutral-800">
                    {provider.label}
                  </div>
                  <div class="truncate text-[11px] text-neutral-500">
                    {provider.defaultModel}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="px-2 py-1"
                  onClick={() => void testProvider(provider.id)}
                >
                  Use
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {providerStatus ? (
          <div class="word-break mt-2 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-2 text-xs leading-5 text-wrap text-neutral-700">
            {providerStatus}
          </div>
        ) : null}
      </div>
    </div>
  );
}
