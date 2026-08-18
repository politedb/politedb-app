import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import {
  DownloadIcon,
  PlayIcon,
  RefreshCwIcon,
  StopIcon,
  VaultIcon,
  XIcon,
} from "src/components/icons";
import {
  AI_PROVIDER_LABELS,
  DEFAULT_LOCAL_AI_PROVIDER_ID,
  DEFAULT_MODELS,
  aiProviderDelete,
  aiProviderList,
  aiProviderTest,
  buildBaseUrl,
  getSelectedAiProviderId,
  isLocalAiProviderKind,
  makeDefaultAiProvider,
  normalizeAiProviderConfig,
  resolveSelectedAiProvider,
  saveAiProviderWithOptionalKey,
  setSelectedAiProviderId,
} from "src/lib/ai-assistant/providers";
import type { AiRuntimeStatus } from "src/lib/tauri";
import type { AiProviderConfig, AiProviderKind } from "src/types";
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
  onDownloadModel: () => void;
  onDeleteLocalModel: () => Promise<void> | void;
};

const PROVIDER_KINDS: AiProviderKind[] = [
  "openai",
  "anthropic",
  "gemini",
  "grok",
  "groq",
  "deepseek",
  "openrouter",
  "github_copilot",
  "ollama",
];

function runtimeLabel(phase?: string) {
  if (phase === "ready") return "Ready";
  if (phase === "starting") return "Starting";
  if (phase === "missing") return "Missing";
  if (phase === "error") return "Error";
  return "Stopped";
}

export function AiAssistantSettingsDialog(props: Props) {
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [selectedKind, setSelectedKind] = useState<AiProviderKind>("openai");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => makeDefaultAiProvider("openai"));
  const [apiKey, setApiKey] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const normalizedProviders = useMemo(
    () => providers.map(normalizeAiProviderConfig),
    [providers]
  );
  const selectedProvider = normalizedProviders.find(
    (provider) => provider.id === selectedId
  );
  const localProvider = normalizedProviders.find(
    (provider) => provider.id === DEFAULT_LOCAL_AI_PROVIDER_ID
  );
  const isLocal = isLocalAiProviderKind(selectedKind);

  const loadProviders = async () => {
    const normalized = (await aiProviderList()).map(normalizeAiProviderConfig);
    const next = normalized.some((provider) => provider.isDefault)
      ? normalized
      : normalized.map((provider) => ({
          ...provider,
          isDefault: provider.id === DEFAULT_LOCAL_AI_PROVIDER_ID,
        }));
    setProviders(next);
    return next;
  };

  const chooseProvider = (
    kind: AiProviderKind,
    provider?: AiProviderConfig
  ) => {
    const next =
      provider ??
      makeDefaultAiProvider(kind, {
        id: kind === "ollama" ? DEFAULT_LOCAL_AI_PROVIDER_ID : undefined,
      });
    setSelectedKind(kind);
    setSelectedId(provider?.id ?? null);
    setDraft(normalizeAiProviderConfig(next));
    setApiKey("");
    setModelInput("");
    setStatus("");
  };

  useEffect(() => {
    if (!props.open) return;
    void loadProviders()
      .then((next) => {
        const provider =
          next.find((item) => item.isDefault) ??
          next.find((item) => item.id === DEFAULT_LOCAL_AI_PROVIDER_ID) ??
          next[0];
        chooseProvider(provider?.kind ?? "openai", provider);
      })
      .catch((error) => setStatus(String(error)));
  }, [props.open]);

  const updateDraft = (patch: Partial<AiProviderConfig>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const addModel = () => {
    const model = modelInput.trim();
    if (!model) return;
    const models = Array.from(new Set([...(draft.models ?? []), model]));
    updateDraft({
      models,
      defaultModel: draft.defaultModel.trim() || model,
    });
    setModelInput("");
  };

  const removeModel = (model: string) => {
    const models = (draft.models ?? []).filter((item) => item !== model);
    updateDraft({
      models,
      defaultModel:
        draft.defaultModel === model ? (models[0] ?? "") : draft.defaultModel,
    });
  };

  const saveProvider = async () => {
    if (!(draft.models ?? []).length) {
      setStatus("Add at least one model before saving.");
      return;
    }
    setBusy(true);
    setStatus("Validating provider and model...");
    try {
      const config = normalizeAiProviderConfig({
        ...draft,
        id:
          selectedProvider?.id ??
          (selectedKind === "ollama" ? DEFAULT_LOCAL_AI_PROVIDER_ID : draft.id),
        kind: selectedKind,
        label: draft.label.trim() || AI_PROVIDER_LABELS[selectedKind],
        defaultModel: draft.defaultModel.trim() || DEFAULT_MODELS[selectedKind],
        models: draft.models,
        baseUrl: buildBaseUrl(draft.host, draft.subPath),
      });
      const saved = await saveAiProviderWithOptionalKey({ config, apiKey });
      if (saved.isDefault) setSelectedAiProviderId(saved.id);
      const next = await loadProviders();
      const normalized = next.find((item) => item.id === saved.id) ?? saved;
      setSelectedId(saved.id);
      setDraft(normalizeAiProviderConfig(normalized));
      setApiKey("");
      setStatus("Provider saved. API key is stored in OS keychain.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const testProvider = async () => {
    if (!selectedProvider) {
      setStatus("Save provider before testing.");
      return;
    }
    setBusy(true);
    setStatus("Testing provider...");
    try {
      await aiProviderTest(selectedProvider.id);
      setStatus("Provider connection succeeded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = async () => {
    if (!selectedProvider) return;
    if (selectedProvider.id === localProvider?.id) {
      if (!window.confirm("Delete downloaded local AI model?")) return;
      setBusy(true);
      try {
        await props.onDeleteLocalModel();
        setStatus("Local AI model deleted.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!window.confirm(`Delete ${selectedProvider.label}?`)) return;
    setBusy(true);
    try {
      const deletedId = selectedProvider.id;
      await aiProviderDelete(deletedId);
      const next = await loadProviders();
      const fallback = resolveSelectedAiProvider(next, deletedId);
      chooseProvider(fallback?.kind ?? "openai", fallback);
      if (getSelectedAiProviderId() === deletedId) {
        setSelectedAiProviderId(fallback?.id ?? DEFAULT_LOCAL_AI_PROVIDER_ID);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      size="xl"
      className="max-w-4xl overflow-hidden"
    >
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle>AI Provider Settings</DialogTitle>
      </DialogHeader>
      <DialogContent className="grid min-h-140 min-w-0 grid-cols-[220px_minmax(0,1fr)] overflow-hidden p-0">
        <aside class="overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-3">
          <div class="space-y-1">
            {PROVIDER_KINDS.map((kind) => {
              const configured = normalizedProviders.filter(
                (provider) => provider.kind === kind
              );
              const active = selectedKind === kind;
              const available =
                configured.length > 0 &&
                (!isLocalAiProviderKind(kind) ||
                  Boolean(props.runtimeStatus?.model_path));
              return (
                <div key={kind}>
                  <button
                    type="button"
                    class={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium",
                      active
                        ? "bg-blue-600 text-white"
                        : "text-neutral-700 hover:bg-neutral-200"
                    )}
                    onClick={() => chooseProvider(kind, configured[0])}
                  >
                    <VaultIcon className="size-4 shrink-0" />
                    <span class="min-w-0 flex-1 truncate">
                      {AI_PROVIDER_LABELS[kind]}
                    </span>
                    {available ? (
                      <span class="size-1.5 rounded-full bg-emerald-400" />
                    ) : null}
                  </button>
                  {active && configured.length > 1 ? (
                    <div class="mt-1 ml-6 space-y-1">
                      {configured.map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          class={cn(
                            "block w-full truncate rounded px-2 py-1 text-left text-xs",
                            selectedId === provider.id
                              ? "bg-neutral-200 font-semibold"
                              : "text-neutral-500 hover:bg-neutral-100"
                          )}
                          onClick={() => chooseProvider(kind, provider)}
                        >
                          {provider.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </aside>

        <main class="min-w-0 overflow-y-auto p-5">
          <div class="space-y-4">
            <Input
              label="Name"
              value={draft.label}
              onValueChange={(value) => updateDraft({ label: value })}
              className="h-10 border border-neutral-300 px-3 text-sm"
            />
            {!isLocal ? (
              <Input
                label="API Key"
                type="password"
                value={apiKey}
                placeholder={
                  draft.apiKeyRef ? "Stored in OS keychain" : "Secret key"
                }
                onValueChange={setApiKey}
                className="h-10 border border-neutral-300 px-3 text-sm"
              />
            ) : null}
            <div class="grid gap-3 sm:grid-cols-2">
              <Input
                label="Host"
                value={draft.host ?? ""}
                onValueChange={(value) => updateDraft({ host: value })}
                className="h-10 border border-neutral-300 px-3 text-sm"
              />
              <Input
                label="Sub Path"
                value={draft.subPath ?? ""}
                onValueChange={(value) => updateDraft({ subPath: value })}
                className="h-10 border border-neutral-300 px-3 text-sm"
              />
            </div>
            <section class="space-y-2">
              <label class="block text-sm font-medium text-neutral-900">
                Models
              </label>
              {!isLocal ? (
                <div class="flex gap-2">
                  <div class="min-w-0 flex-1">
                    <Input
                      value={modelInput}
                      placeholder="Model ID"
                      onValueChange={setModelInput}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addModel();
                      }}
                      className="h-10 w-full border border-neutral-300 px-3 text-sm"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!modelInput.trim()}
                    onClick={addModel}
                  >
                    Add
                  </Button>
                </div>
              ) : null}
              <div class="overflow-hidden rounded-lg border border-neutral-200">
                {(draft.models ?? []).length ? (
                  (draft.models ?? []).map((model) => (
                    <div
                      key={model}
                      class="flex min-w-0 items-center gap-2 border-b border-neutral-100 px-3 py-2 last:border-b-0"
                    >
                      <span
                        class="min-w-0 flex-1 truncate text-sm"
                        title={model}
                      >
                        {model}
                      </span>
                      {!isLocal ? (
                        <button
                          type="button"
                          class="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600"
                          title={`Remove ${model}`}
                          aria-label={`Remove ${model}`}
                          onClick={() => removeModel(model)}
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div class="px-3 py-3 text-sm text-neutral-400">
                    No models selected.
                  </div>
                )}
              </div>
            </section>
            <label class="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={Boolean(draft.isDefault)}
                onChange={(event) =>
                  updateDraft({ isDefault: event.currentTarget.checked })
                }
              />
              Default provider
            </label>

            {isLocal ? (
              <section class="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="text-sm font-semibold text-neutral-900">
                      Local Runtime
                    </div>
                    <div class="text-xs text-neutral-500">
                      Bundled Qwen2.5-Coder-7B on this device.
                    </div>
                  </div>
                  <span class="rounded-full border border-neutral-200 bg-white px-2 py-1 text-xs">
                    {runtimeLabel(props.runtimeStatus?.phase)}
                  </span>
                </div>
                <div class="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant={
                      props.runtimeStatus?.phase === "ready"
                        ? "destructive"
                        : "default"
                    }
                    onClick={
                      props.runtimeStatus?.phase === "ready"
                        ? props.onStopRuntime
                        : props.onStartRuntime
                    }
                    loading={props.runtimeBusy}
                  >
                    {props.runtimeStatus?.phase === "ready" ? (
                      <>
                        <StopIcon className="size-3.5" /> Stop
                      </>
                    ) : (
                      <>
                        <PlayIcon className="size-3.5" /> Start
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={props.onLoadModels}
                    loading={props.loadingModels}
                  >
                    <RefreshCwIcon className="size-3.5" /> Refresh
                  </Button>
                  {!props.runtimeStatus?.model_path ? (
                    <Button
                      variant="outline"
                      onClick={props.onDownloadModel}
                      disabled={props.runtimeBusy}
                    >
                      <DownloadIcon className="size-3.5" /> Download model
                    </Button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {status ? (
              <div class="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm wrap-break-word text-neutral-700">
                {status}
              </div>
            ) : null}

            <div class="flex items-center justify-between gap-2 border-t border-neutral-200 pt-4">
              <Button
                variant="destructive"
                onClick={() => void deleteProvider()}
                disabled={
                  !selectedProvider ||
                  busy ||
                  (selectedProvider.id === localProvider?.id &&
                    !props.runtimeStatus?.model_path)
                }
              >
                Delete
              </Button>
              <div class="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => void testProvider()}
                  disabled={!selectedProvider || busy}
                >
                  Test
                </Button>
                <Button
                  loading={busy}
                  disabled={!(draft.models ?? []).length}
                  onClick={() => void saveProvider()}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </main>
      </DialogContent>
    </Dialog>
  );
}
