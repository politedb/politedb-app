import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { RefreshCwIcon, VaultIcon, XIcon } from "src/components/icons";
import {
  AI_PROVIDER_LABELS,
  SUGGESTED_MODELS,
  aiProviderDelete,
  aiProviderKeyCapability,
  aiProviderList,
  aiProviderCancelListModels,
  aiProviderListModels,
  aiProviderTestDraft,
  buildBaseUrl,
  dismissLegacyLocalNotice,
  getSelectedAiProviderId,
  isLegacyBundledProvider,
  isLegacyLocalNoticeDismissed,
  isLocalAiProviderKind,
  makeDefaultAiProvider,
  normalizeAiProviderConfig,
  resolveSelectedAiProvider,
  saveAiProvider,
  setSelectedAiProviderId,
  type AiProviderKeyChange,
} from "src/lib/ai-assistant/providers";
import {
  aiLegacyModelDelete,
  aiLegacyModelInfo,
  type AiLegacyModelInfo,
} from "src/lib/tauri/ai";
import type { AiProviderConfig, AiProviderKind } from "src/types";
import { cn } from "src/utils/cn";
import { AiModelCombobox } from "./AiModelCombobox";
import { formatBytesSize } from "src/utils/convert";

type Props = {
  open: boolean;
  onClose: () => void;
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
  "local_openai_compatible",
];

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function AiAssistantSettingsDialog(props: Props) {
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [selectedKind, setSelectedKind] = useState<AiProviderKind>("openai");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => makeDefaultAiProvider("openai"));
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  // Ids the server reported on the last Load models, offered again as suggestions.
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [legacyModel, setLegacyModel] = useState<AiLegacyModelInfo | null>(
    null
  );
  const [legacyNoticeDismissed, setLegacyNoticeDismissed] = useState(() =>
    isLegacyLocalNoticeDismissed()
  );
  // Bumped whenever the draft's URL/auth/identity changes so late model lists are ignored.
  const draftTokenRef = useRef(0);

  // Discovery requests are scoped to this dialog instance so other panels are unaffected.
  const instanceIdRef = useRef(
    `settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  const discoveryIdRef = useRef<string | null>(null);
  // Models the user removed while a discovery was running must not come back.
  const removedDuringDiscoveryRef = useRef(new Set<string>());

  /** Drops any in-flight model discovery: its result no longer matches the form. */
  const invalidateDiscovery = () => {
    draftTokenRef.current += 1;
    setLoadingModels(false);
    const requestId = discoveryIdRef.current;
    discoveryIdRef.current = null;
    if (requestId) void aiProviderCancelListModels(requestId);
  };

  const normalizedProviders = useMemo(
    () => providers.map(normalizeAiProviderConfig),
    [providers]
  );
  const selectedProvider = normalizedProviders.find(
    (provider) => provider.id === selectedId
  );
  const keyCapability = aiProviderKeyCapability(selectedKind);
  const isLocal = isLocalAiProviderKind(selectedKind);
  const showLegacyNotice =
    !legacyNoticeDismissed &&
    Boolean(selectedProvider && isLegacyBundledProvider(selectedProvider));

  const loadProviders = async () => {
    const next = (await aiProviderList()).map(normalizeAiProviderConfig);
    setProviders(next);
    return next;
  };

  const refreshLegacyModel = async () => {
    try {
      setLegacyModel(await aiLegacyModelInfo());
    } catch {
      setLegacyModel(null);
    }
  };

  const clearSecrets = () => {
    setApiKey("");
    setRemoveKey(false);
  };

  const chooseProvider = (
    kind: AiProviderKind,
    provider?: AiProviderConfig
  ) => {
    invalidateDiscovery();
    setSelectedKind(kind);
    setSelectedId(provider?.id ?? null);
    setDraft(
      normalizeAiProviderConfig(provider ?? makeDefaultAiProvider(kind))
    );
    clearSecrets();
    setDiscoveredModels([]);
    setStatus("");
  };

  useEffect(() => {
    if (!props.open) {
      // Never keep a typed secret around after the dialog closes.
      invalidateDiscovery();
      clearSecrets();
      return;
    }
    void refreshLegacyModel();
    void loadProviders()
      .then((next) => {
        const provider =
          next.find((item) => item.id === getSelectedAiProviderId()) ??
          next.find((item) => item.isDefault) ??
          next[0];
        chooseProvider(provider?.kind ?? "openai", provider);
      })
      .catch((error) => setStatus(errorText(error)));
  }, [props.open]);

  const updateDraft = (patch: Partial<AiProviderConfig>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  /** Merges into the latest draft so edits made while a request was running survive. */
  const addModels = (ids: string[]) => {
    setDraft((current) => {
      const models = Array.from(
        new Set(
          [...(current.models ?? []), ...ids]
            .map((id) => id.trim())
            .filter(Boolean)
        )
      );
      return {
        ...current,
        models,
        defaultModel: current.defaultModel.trim() || models[0] || "",
      };
    });
  };

  /** URL or auth edits make an in-flight discovery stale. */
  const updateConnection = (patch: Partial<AiProviderConfig>) => {
    invalidateDiscovery();
    updateDraft(patch);
  };

  const modelSuggestions = useMemo(
    () => [...discoveredModels, ...SUGGESTED_MODELS[selectedKind]],
    [discoveredModels, selectedKind]
  );

  const removeModel = (model: string) => {
    removedDuringDiscoveryRef.current.add(model);
    const models = (draft.models ?? []).filter((item) => item !== model);
    updateDraft({
      models,
      defaultModel:
        draft.defaultModel === model ? (models[0] ?? "") : draft.defaultModel,
    });
  };

  /** Draft as the backend expects it; nothing here touches storage. */
  const draftConfig = (): AiProviderConfig =>
    normalizeAiProviderConfig({
      ...draft,
      id: selectedProvider?.id ?? draft.id,
      kind: selectedKind,
      label: draft.label.trim() || AI_PROVIDER_LABELS[selectedKind],
      baseUrl: buildBaseUrl(draft.host, draft.subPath),
    });

  const keyChange = (): AiProviderKeyChange => {
    if (keyCapability === "none") return { action: "keep" };
    if (removeKey) return { action: "remove" };
    return apiKey.trim()
      ? { action: "set", value: apiKey.trim() }
      : { action: "keep" };
  };

  const loadModels = async () => {
    invalidateDiscovery();
    const token = draftTokenRef.current;
    const requestId = `${instanceIdRef.current}:${token}`;
    discoveryIdRef.current = requestId;
    removedDuringDiscoveryRef.current = new Set();
    setLoadingModels(true);
    setStatus("Loading models from server...");
    try {
      const listed = await aiProviderListModels(
        draftConfig(),
        keyChange(),
        requestId
      );
      if (token !== draftTokenRef.current) return;
      setDiscoveredModels(listed);
      const ids = listed.filter(
        (id) => !removedDuringDiscoveryRef.current.has(id)
      );
      if (!ids.length) {
        setStatus(
          "The server returned no models. You can still add one by ID."
        );
        return;
      }
      addModels(ids);
      setStatus(`Loaded ${ids.length} model${ids.length === 1 ? "" : "s"}.`);
    } catch (error) {
      if (token === draftTokenRef.current) setStatus(errorText(error));
    } finally {
      if (token === draftTokenRef.current) {
        setLoadingModels(false);
        discoveryIdRef.current = null;
      }
    }
  };

  const saveProvider = async () => {
    setBusy(true);
    setStatus("Saving provider...");
    try {
      const saved = await saveAiProvider({
        config: draftConfig(),
        keyChange: keyChange(),
      });
      if (saved.isDefault && saved.enabled) setSelectedAiProviderId(saved.id);
      const next = await loadProviders();
      const normalized = next.find((item) => item.id === saved.id) ?? saved;
      setSelectedId(saved.id);
      setDraft(normalizeAiProviderConfig(normalized));
      clearSecrets();
      setStatus(
        saved.apiKeyRef
          ? "Provider saved. API key is stored in the OS keychain."
          : "Provider saved."
      );
    } catch (error) {
      setStatus(errorText(error));
      if (String(error).includes("AI_PROVIDER_SAVE_ROLLBACK_FAILED")) {
        // Show what is actually on disk now; never write again from here.
        const next = await loadProviders().catch(() => null);
        const onDisk = next?.find((item) => item.id === draftConfig().id);
        if (onDisk) setDraft(normalizeAiProviderConfig(onDisk));
        clearSecrets();
      }
    } finally {
      setBusy(false);
    }
  };

  const testProvider = async () => {
    if (!draft.defaultModel.trim()) {
      setStatus("Choose a model before testing.");
      return;
    }
    setBusy(true);
    setStatus("Testing provider...");
    try {
      await aiProviderTestDraft(draftConfig(), keyChange());
      setStatus("Provider connection succeeded.");
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteProvider = async () => {
    if (!selectedProvider) return;
    if (!window.confirm(`Delete ${selectedProvider.label}?`)) return;
    setBusy(true);
    try {
      await aiProviderDelete(selectedProvider.id);
      const next = await loadProviders();
      // The chat selection is left alone on purpose: if it pointed at the deleted
      // provider, open panels ask the user before switching (plan R6).
      const fallback = resolveSelectedAiProvider(
        next,
        getSelectedAiProviderId()
      );
      chooseProvider(fallback?.kind ?? selectedKind, fallback);
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteLegacyModel = async () => {
    if (
      !window.confirm(
        "Delete the AI model downloaded by earlier PoliteDB versions? This frees disk space and cannot be undone."
      )
    ) {
      return;
    }
    try {
      const remaining = await aiLegacyModelDelete();
      setStatus(
        remaining.files.length
          ? `Could not delete: ${remaining.files.map((f) => f.name).join(", ")}`
          : "Old built-in AI model deleted."
      );
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      void refreshLegacyModel();
    }
  };

  const legacyModelBytes =
    legacyModel?.files.reduce((sum, file) => sum + file.sizeBytes, 0) ?? 0;

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
        <aside class="min-h-0 overflow-hidden border-r border-neutral-200 bg-neutral-50">
          <OverlayScrollArea
            className="h-full"
            contentClassName="space-y-1 p-3"
          >
            {PROVIDER_KINDS.map((kind) => {
              const configured = normalizedProviders.filter(
                (provider) => provider.kind === kind
              );
              const active = selectedKind === kind;
              const ready = configured.some((provider) => provider.enabled);
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
                    {ready ? (
                      <span class="size-2 rounded-full bg-emerald-400" />
                    ) : null}
                  </button>
                  {active && configured.length > 0 ? (
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
                          {provider.enabled ? "" : " (off)"}
                        </button>
                      ))}
                      <button
                        type="button"
                        class={cn(
                          "block w-full truncate rounded px-2 py-1 text-left text-xs",
                          selectedId === null
                            ? "bg-neutral-200 font-semibold"
                            : "text-neutral-500 hover:bg-neutral-100"
                        )}
                        onClick={() => chooseProvider(kind)}
                      >
                        + Add another
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </OverlayScrollArea>
        </aside>

        <main class="min-h-0 min-w-0 overflow-hidden">
          <OverlayScrollArea
            className="h-full"
            contentClassName="space-y-4 p-5"
          >
            {showLegacyNotice ? (
              <div class="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <span>
                  If this was PoliteDB's built-in AI, it has been removed. Enter
                  the URL of your own local server (for example Ollama or LM
                  Studio) and load its models.
                </span>
                <button
                  type="button"
                  class="shrink-0 text-xs font-medium underline"
                  onClick={() => {
                    dismissLegacyLocalNotice();
                    setLegacyNoticeDismissed(true);
                  }}
                >
                  Dismiss
                </button>
              </div>
            ) : null}
            <Input
              label="Name"
              value={draft.label}
              onValueChange={(value) => updateDraft({ label: value })}
              className="h-10 border border-neutral-300 px-3 text-sm"
            />
            <label class="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  updateDraft({ enabled: event.currentTarget.checked })
                }
              />
              Enabled
            </label>
            {keyCapability !== "none" ? (
              <div class="space-y-1">
                <Input
                  label={
                    keyCapability === "optional"
                      ? "API Key (optional)"
                      : "API Key"
                  }
                  type="password"
                  value={apiKey}
                  disabled={removeKey}
                  placeholder={
                    removeKey
                      ? "Key will be removed on save"
                      : draft.apiKeyRef
                        ? "Stored in OS keychain"
                        : "Secret key"
                  }
                  onValueChange={(value) => {
                    invalidateDiscovery();
                    setApiKey(value);
                  }}
                  className="h-10 border border-neutral-300 px-3 text-sm"
                />
                {keyCapability === "optional" && draft.apiKeyRef ? (
                  <button
                    type="button"
                    class="text-xs text-neutral-500 underline"
                    onClick={() => {
                      invalidateDiscovery();
                      setApiKey("");
                      setRemoveKey((current) => !current);
                    }}
                  >
                    {removeKey ? "Keep stored key" : "Remove stored key"}
                  </button>
                ) : null}
                {keyCapability === "optional" &&
                draft.host?.trim().toLowerCase().startsWith("http://") ? (
                  <div class="text-xs text-neutral-500">
                    Over plain http the key is sent unencrypted on your network.
                    Prefer https for servers that require a key.
                  </div>
                ) : null}
              </div>
            ) : null}
            <div class="grid gap-3 sm:grid-cols-2">
              <Input
                label="Host"
                value={draft.host ?? ""}
                placeholder={isLocal ? "http://127.0.0.1:1234" : undefined}
                onValueChange={(value) => updateConnection({ host: value })}
                className="h-10 border border-neutral-300 px-3 text-sm"
              />
              <Input
                label="Sub Path"
                value={draft.subPath ?? ""}
                onValueChange={(value) => updateConnection({ subPath: value })}
                className="h-10 border border-neutral-300 px-3 text-sm"
              />
            </div>
            {isLocal ? (
              <div class="text-xs text-neutral-500">
                Plain http works for localhost and LAN IP addresses (for example
                192.168.1.20). Other hosts need https.
              </div>
            ) : null}
            <section class="space-y-2">
              <div class="flex items-center justify-between">
                <label class="block text-sm font-medium text-neutral-900">
                  Models
                </label>
                {isLocal ? (
                  <Button
                    type="button"
                    variant="outline"
                    loading={loadingModels}
                    onClick={() => void loadModels()}
                  >
                    <RefreshCwIcon className="size-3.5" /> Load models
                  </Button>
                ) : null}
              </div>
              <AiModelCombobox
                suggestions={modelSuggestions}
                selected={draft.models ?? []}
                onAdd={(model) => addModels([model])}
              />
              <div class="overflow-hidden rounded-lg border border-neutral-200">
                {(draft.models ?? []).length ? (
                  (draft.models ?? []).map((model) => (
                    <div
                      key={model}
                      class="flex min-w-0 items-center gap-2 border-b border-neutral-100 px-3 py-2 last:border-b-0"
                    >
                      <button
                        type="button"
                        class="min-w-0 flex-1 truncate text-left text-sm"
                        title="Use as default model"
                        onClick={() => updateDraft({ defaultModel: model })}
                      >
                        {model}
                      </button>
                      {draft.defaultModel === model ? (
                        <span class="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                          default
                        </span>
                      ) : null}
                      <button
                        type="button"
                        class="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-red-600"
                        title={`Remove ${model}`}
                        aria-label={`Remove ${model}`}
                        onClick={() => removeModel(model)}
                      >
                        <XIcon className="size-3.5" />
                      </button>
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

            {legacyModel?.files.length ? (
              <section class="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                <div class="text-sm text-neutral-700">
                  An AI model downloaded by earlier PoliteDB versions is still
                  on disk (
                  {formatBytesSize(legacyModelBytes, { fractionDigits: 2 })}).
                </div>
                <Button
                  variant="outline"
                  onClick={() => void deleteLegacyModel()}
                >
                  Delete
                </Button>
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
                disabled={!selectedProvider || busy}
              >
                Delete
              </Button>
              <div class="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => void testProvider()}
                  disabled={busy || !draft.defaultModel.trim()}
                >
                  Test
                </Button>
                <Button loading={busy} onClick={() => void saveProvider()}>
                  Save
                </Button>
              </div>
            </div>
          </OverlayScrollArea>
        </main>
      </DialogContent>
    </Dialog>
  );
}
