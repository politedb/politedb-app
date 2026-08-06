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
  PlayIcon,
  RefreshCwIcon,
  StopIcon,
  VaultIcon,
} from "src/components/icons";
import type { AiRuntimeStatus } from "src/lib/tauri";
import type { AiProviderConfig, AiProviderKind } from "src/types";
import {
  AI_PROVIDER_LABELS,
  DEFAULT_HOSTS,
  DEFAULT_MODELS,
  DEFAULT_SUB_PATHS,
  aiProviderDelete,
  aiProviderList,
  aiProviderTest,
  buildBaseUrl,
  makeDefaultAiProvider,
  normalizeAiProviderConfig,
  saveAiProviderWithOptionalKey,
  setSelectedAiProviderId,
} from "src/lib/aiProviders";
import { cn } from "src/utils/cn";

type Props = {
  open: boolean;
  onClose: () => void;
  loadingModels: boolean;
  runtimeBusy: boolean;
  runtimeStatus: AiRuntimeStatus | null;
  onLoadModels: () => void;
  onStartRuntime: () => void;
  onStopRuntime: () => void;
};

const VENDOR_ORDER: AiProviderKind[] = ["ollama"];

function providerForKind(providers: AiProviderConfig[], kind: AiProviderKind) {
  return providers.find((provider) => provider.kind === kind);
}

function runtimeLabel(phase?: string) {
  if (phase === "ready") return "Ready";
  if (phase === "starting") return "Starting";
  if (phase === "missing") return "Missing";
  if (phase === "error") return "Error";
  return "Stopped";
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
  } = props;

  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [selectedKind, setSelectedKind] = useState<AiProviderKind>("ollama");
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [subPath, setSubPath] = useState("");
  const [model, setModel] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const normalizedProviders = useMemo(
    () => providers.map(normalizeAiProviderConfig),
    [providers]
  );
  const selectedProvider = providerForKind(normalizedProviders, selectedKind);
  const loadProviders = async () => {
    const next = await aiProviderList().catch(() => []);
    setProviders(next.map(normalizeAiProviderConfig));
  };

  useEffect(() => {
    if (open) void loadProviders();
  }, [open]);

  useEffect(() => {
    const provider = providerForKind(normalizedProviders, selectedKind);
    setLabel(provider?.label ?? AI_PROVIDER_LABELS[selectedKind]);
    setHost(provider?.host ?? DEFAULT_HOSTS[selectedKind]);
    setSubPath(provider?.subPath ?? DEFAULT_SUB_PATHS[selectedKind]);
    setModel(provider?.defaultModel ?? DEFAULT_MODELS[selectedKind]);
    setIsDefault(!!provider?.isDefault);
    setStatus("");
  }, [normalizedProviders, selectedKind]);

  const saveProvider = async () => {
    setBusy(true);
    setStatus("");
    try {
      const config = makeDefaultAiProvider(selectedKind, {
        id: selectedProvider?.id,
        label,
        host,
        subPath,
        baseUrl: buildBaseUrl(host, subPath),
        defaultModel: model,
        enabled: true,
        isDefault,
      });
      const saved = await saveAiProviderWithOptionalKey({ config });
      if (isDefault) setSelectedAiProviderId(saved.id);
      await loadProviders();
      setStatus(`Saved ${saved.label}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const testProvider = async () => {
    const provider = selectedProvider;
    if (!provider) {
      setStatus("Save this provider before testing it.");
      return;
    }
    setBusy(true);
    setStatus("Testing provider...");
    try {
      await aiProviderTest(provider.id);
      setSelectedAiProviderId(provider.id);
      setStatus("Provider test succeeded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = async () => {
    const provider = selectedProvider;
    if (!provider) return;
    setBusy(true);
    setStatus("");
    try {
      await aiProviderDelete(provider.id);
      await loadProviders();
      setStatus(`Deleted ${provider.label}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      className="max-w-4xl overflow-hidden"
    >
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle>AI Provider Settings</DialogTitle>
      </DialogHeader>
      <DialogContent className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-0 p-0">
        <div class="border-r border-neutral-200 bg-neutral-50 p-4">
          <div class="space-y-1">
            {VENDOR_ORDER.map((kind) => {
              const active = selectedKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setSelectedKind(kind)}
                  class={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-semibold transition-colors",
                    active
                      ? "bg-blue-600 text-white"
                      : "text-neutral-800 hover:bg-white"
                  )}
                >
                  <VaultIcon className="size-4" />
                  {AI_PROVIDER_LABELS[kind]}
                </button>
              );
            })}
          </div>
        </div>

        <div class="min-h-0 overflow-y-auto p-4">
          <div class="max-w-2xl space-y-4">
            <Input
              label="Name"
              value={label}
              onValueChange={setLabel}
              className="h-10 border border-neutral-300 px-3 text-sm focus:border-blue-500"
            />

            <Input
              label="Host"
              value={host}
              onValueChange={setHost}
              className="h-10 border border-neutral-300 px-3 text-sm focus:border-blue-500"
            />

            <Input
              label="Sub Path"
              value={subPath}
              onValueChange={setSubPath}
              className="h-10 border border-neutral-300 px-3 text-sm focus:border-blue-500"
            />

            <Input
              label="Default Model"
              value={model}
              onValueChange={setModel}
              className="h-10 border border-neutral-300 px-3 text-center text-sm focus:border-blue-500"
            />

            <label class="flex items-center gap-2 text-sm font-medium text-neutral-800">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.currentTarget.checked)}
                class="size-4"
              />
              Default Vendor
            </label>

            <div class="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
              <div class="mb-2 flex items-center justify-between gap-2">
                <div class="text-sm font-semibold text-neutral-900">
                  Local Runtime
                </div>
                <div class="rounded-full border border-neutral-200 bg-white px-2 py-1 text-xs font-semibold text-neutral-700">
                  {runtimeLabel(runtimeStatus?.phase)}
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Button
                  variant={
                    runtimeStatus?.phase === "ready" ? "destructive" : "default"
                  }
                  class="px-3 py-1"
                  onClick={
                    runtimeStatus?.phase === "ready"
                      ? onStopRuntime
                      : onStartRuntime
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
                  class="px-3 py-1"
                  onClick={onLoadModels}
                  loading={loadingModels}
                >
                  <RefreshCwIcon className="size-3.5" />
                  Refresh
                </Button>
              </div>
            </div>

            {status ? (
              <div class="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                {status}
              </div>
            ) : null}

            <div class="flex items-center justify-end gap-2 border-t border-neutral-200 pt-4">
              {selectedProvider ? (
                <Button
                  variant="outline"
                  class="px-3 py-1"
                  onClick={() => void deleteProvider()}
                  disabled={busy}
                >
                  Delete
                </Button>
              ) : null}
              <Button
                variant="outline"
                class="px-3 py-1"
                onClick={() => void testProvider()}
                disabled={busy || !selectedProvider}
              >
                Test
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
