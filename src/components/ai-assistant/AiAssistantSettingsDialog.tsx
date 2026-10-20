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
import {
  RefreshCwIcon,
  SparklesIcon,
  UnlockIcon,
  VaultIcon,
  XIcon,
} from "src/components/icons";
import {
  AI_PROVIDER_LABELS,
  SUGGESTED_MODELS,
  aiProviderDelete,
  aiProviderKeyCapability,
  aiProviderList,
  aiProviderCancelListModels,
  aiProviderListModels,
  aiProviderTestDraft,
  aiOllamaStatus,
  DEFAULT_CONTEXT_SIZE,
  MAX_CONTEXT_SIZE,
  MIN_CONTEXT_SIZE,
  parseContextSize,
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
  type OllamaStatus,
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
  // Ids the server reported on the last discovery, offered again as suggestions.
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
  /** Shown in the empty model list when a silent discovery could not reach the server. */
  const [serverHint, setServerHint] = useState<string | null>(null);
  /** Bumped to focus the model picker and open its suggestions. */
  const [pickerFocusRequest, setPickerFocusRequest] = useState(0);
  /** Ollama only: the context size field as typed, and the server status line. */
  const [contextInput, setContextInput] = useState("");
  const [contextError, setContextError] = useState<string | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const statusTokenRef = useRef(0);
  const statusIdRef = useRef<string | null>(null);

  /**
   * Drops the shown server status and aborts its request in the backend (plan
   * ollama-native-context C2). Called on every draft edit that changes what the status
   * describes, even when no new request follows.
   */
  const invalidateStatus = () => {
    statusTokenRef.current += 1;
    setOllamaStatus(null);
    setStatusLoading(false);
    const requestId = statusIdRef.current;
    statusIdRef.current = null;
    if (requestId) void aiProviderCancelListModels(requestId);
  };

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

  /** Asks the server behind an Ollama draft what it supports (explicit actions only). */
  const loadOllamaStatus = async (config: AiProviderConfig) => {
    invalidateStatus();
    if (config.kind !== "ollama") return;
    const token = statusTokenRef.current;
    const requestId = `${instanceIdRef.current}:status:${token}`;
    statusIdRef.current = requestId;
    setStatusLoading(true);
    try {
      const response = await aiOllamaStatus(config, requestId);
      if (token !== statusTokenRef.current || response?.requestId !== requestId)
        return;
      setOllamaStatus(response);
    } catch {
      if (token !== statusTokenRef.current) return;
      setOllamaStatus(null);
    } finally {
      if (token === statusTokenRef.current) {
        setStatusLoading(false);
        statusIdRef.current = null;
      }
    }
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
  };

  const chooseProvider = (
    kind: AiProviderKind,
    provider?: AiProviderConfig
  ) => {
    invalidateDiscovery();
    invalidateStatus();
    const next = normalizeAiProviderConfig(
      provider ?? makeDefaultAiProvider(kind)
    );
    setSelectedKind(kind);
    setSelectedId(provider?.id ?? null);
    setDraft(next);
    setContextInput(next.contextSize ? String(next.contextSize) : "");
    setContextError(null);
    clearSecrets();
    setDiscoveredModels([]);
    setServerHint(null);
    setStatus("");
    // Local servers expose whatever is installed: look it up right away.
    if (isLocalAiProviderKind(kind)) {
      const config = {
        ...next,
        baseUrl: buildBaseUrl(next.host, next.subPath),
      };
      void loadModels({ silent: true, config, auth: { action: "keep" } });
      void loadOllamaStatus(config);
    }
  };

  useEffect(() => {
    if (!props.open) {
      // Never keep a typed secret around after the dialog closes.
      invalidateDiscovery();
      invalidateStatus();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const updateDraft = (patch: Partial<AiProviderConfig>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  /** Merges into the latest draft so edits made while a request was running survive. */
  const addModels = (ids: string[]) => {
    // The first model added becomes the default: the shown status is then stale.
    const firstDefault = draft.defaultModel.trim()
      ? null
      : (ids.map((id) => id.trim()).find(Boolean) ?? null);
    if (firstDefault) defaultModelChanged(firstDefault);
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
    invalidateStatus();
    // Models found on the previous URL no longer apply.
    setDiscoveredModels([]);
    setServerHint(null);
    updateDraft(patch);
  };

  const modelSuggestions = useMemo(
    () => [...discoveredModels, ...SUGGESTED_MODELS[selectedKind]],
    [discoveredModels, selectedKind]
  );

  /** Choosing another default model makes the shown context status stale. */
  /**
   * Every change of the default model (picked, removed, first added) drops the shown
   * status and its pending request, then asks again for the new model (C2/C5).
   */
  const defaultModelChanged = (model: string) => {
    if (selectedKind !== "ollama") return;
    void loadOllamaStatus({ ...draftConfig(), defaultModel: model });
  };

  const setDefaultModel = (model: string) => {
    if (model === draft.defaultModel) return;
    updateDraft({ defaultModel: model });
    defaultModelChanged(model);
  };

  const updateContextSize = (raw: string) => {
    setContextInput(raw);
    const parsed = parseContextSize(raw);
    if (parsed === undefined) {
      setContextError(
        `Enter a whole number from ${MIN_CONTEXT_SIZE} to ${MAX_CONTEXT_SIZE}, or leave it empty for ${DEFAULT_CONTEXT_SIZE}.`
      );
      return;
    }
    setContextError(null);
    updateDraft({ contextSize: parsed });
  };

  const removeModel = (model: string) => {
    const models = (draft.models ?? []).filter((item) => item !== model);
    const defaultModel =
      draft.defaultModel === model ? (models[0] ?? "") : draft.defaultModel;
    updateDraft({ models, defaultModel });
    if (defaultModel !== draft.defaultModel) defaultModelChanged(defaultModel);
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
    return apiKey.trim()
      ? { action: "set", value: apiKey.trim() }
      : { action: "keep" };
  };

  /**
   * Fetches the server's model ids into the picker's suggestions (never into the
   * selected list). `silent` runs on open/URL blur: failures become a hint, not an error.
   */
  const loadModels = async (
    options: {
      silent?: boolean;
      config?: AiProviderConfig;
      auth?: AiProviderKeyChange;
    } = {}
  ) => {
    invalidateDiscovery();
    const token = draftTokenRef.current;
    const requestId = `${instanceIdRef.current}:${token}`;
    discoveryIdRef.current = requestId;
    setLoadingModels(true);
    if (!options.silent) setStatus("Loading models from server...");
    try {
      const response = await aiProviderListModels(
        options.config ?? draftConfig(),
        options.auth ?? keyChange(),
        requestId
      );
      const listed = Array.isArray(response) ? response : [];
      if (token !== draftTokenRef.current) return;
      setDiscoveredModels(listed);
      setServerHint(listed.length ? null : "The server returned no models.");
      if (!options.silent) {
        setStatus(
          listed.length
            ? `Found ${listed.length} model${listed.length === 1 ? "" : "s"} — pick from the list.`
            : "The server returned no models. You can still type a model ID."
        );
        if (listed.length) setPickerFocusRequest((n) => n + 1);
      }
    } catch (error) {
      if (token !== draftTokenRef.current) return;
      setDiscoveredModels([]);
      if (options.silent) {
        setServerHint(
          "Couldn't reach the server. Start it, then click Reload (↻) — or type a model ID above."
        );
      } else {
        setStatus(errorText(error));
      }
    } finally {
      if (token === draftTokenRef.current) {
        setLoadingModels(false);
        discoveryIdRef.current = null;
      }
    }
  };

  /** Re-discovers after the server URL was edited (local servers only). */
  const reloadModelsAfterUrlEdit = () => {
    if (!isLocal) return;
    void loadModels({ silent: true });
    void loadOllamaStatus(draftConfig());
  };

  const saveProvider = async () => {
    if (contextError) {
      setStatus(contextError);
      return;
    }
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
      if (selectedKind === "ollama") void loadOllamaStatus(draftConfig());
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
        <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
          <SparklesIcon className="size-4" />
          AI Provider Settings
        </DialogTitle>
      </DialogHeader>
      <DialogContent className="grid h-[min(40rem,calc(90vh-5rem))] min-w-0 grid-cols-[220px_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <aside class="flex min-h-0 flex-col overflow-hidden border-r border-neutral-200 bg-neutral-50">
          <OverlayScrollArea
            className="min-h-0 flex-1"
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
                    {ready ? (
                      <UnlockIcon className="size-4 shrink-0" />
                    ) : (
                      <VaultIcon className="size-4 shrink-0" />
                    )}

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
          <div class="max-h-[45%] shrink-0 space-y-2 overflow-y-auto border-t border-neutral-200 p-3 text-xs text-neutral-600">
            <p class="text-neutral-500">
              Chat history is stored on this device without encryption.
            </p>
          </div>
        </aside>

        <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {/* The form scrolls; the action bar below stays pinned to the bottom. */}
          <OverlayScrollArea
            className="min-h-0 flex-1"
            contentClassName="space-y-4 p-5"
          >
            {showLegacyNotice ? (
              <div class="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <span>
                  If this was PoliteDB's built-in AI, it has been removed. Enter
                  the URL of your own Ollama server and load its models.
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
              <Input
                label="API Key"
                type="password"
                value={apiKey}
                placeholder={
                  draft.apiKeyRef ? "Stored in OS keychain" : "Secret key"
                }
                onValueChange={(value) => {
                  invalidateDiscovery();
                  setApiKey(value);
                }}
                className="h-10 border border-neutral-300 px-3 text-sm"
              />
            ) : null}
            <div class="grid gap-3 sm:grid-cols-2">
              <Input
                label="Host"
                value={draft.host ?? ""}
                placeholder={isLocal ? "http://127.0.0.1:11434" : undefined}
                onValueChange={(value) => updateConnection({ host: value })}
                onBlur={reloadModelsAfterUrlEdit}
                className="h-10 border border-neutral-300 px-3 text-sm"
              />
              <Input
                label="Sub Path"
                value={draft.subPath ?? ""}
                onValueChange={(value) => updateConnection({ subPath: value })}
                onBlur={reloadModelsAfterUrlEdit}
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
                    variant="ghost"
                    className="px-1.5"
                    title="Reload models from the server"
                    aria-label="Reload models"
                    loading={loadingModels}
                    onClick={() => void loadModels()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
              <AiModelCombobox
                suggestions={modelSuggestions}
                selected={draft.models ?? []}
                onAdd={(model) => addModels([model])}
                focusRequest={pickerFocusRequest}
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
                        onClick={() => setDefaultModel(model)}
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
                    {!isLocal
                      ? "No models selected."
                      : loadingModels
                        ? "Looking for models on the server..."
                        : discoveredModels.length
                          ? `${discoveredModels.length} model${discoveredModels.length === 1 ? "" : "s"} found on the server — pick from the list above.`
                          : (serverHint ??
                            "Start the server, then click Reload (↻) — or type a model ID above.")}
                  </div>
                )}
              </div>
            </section>
            {selectedKind === "ollama" ? (
              <section class="space-y-1.5">
                <Input
                  label="Context size (tokens)"
                  value={contextInput}
                  placeholder={String(DEFAULT_CONTEXT_SIZE)}
                  onValueChange={updateContextSize}
                  className="h-10 border border-neutral-300 px-3 text-sm"
                />
                {contextError ? (
                  <div class="text-xs text-red-600" role="alert">
                    {contextError}
                  </div>
                ) : null}
                <OllamaStatusLine
                  status={ollamaStatus}
                  loading={statusLoading}
                  setting={parseContextSize(contextInput) ?? null}
                />
              </section>
            ) : null}
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
          </OverlayScrollArea>
          <div class="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 bg-white px-5 py-3">
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
        </main>
      </DialogContent>
    </Dialog>
  );
}

/** What the agent can do with this Ollama server (plan ollama-native-context C5). */
function OllamaStatusLine(props: {
  status: OllamaStatus | null;
  loading: boolean;
  setting: number | null;
}) {
  const { status } = props;
  let text: string;
  if (props.loading) {
    text = "Checking the server...";
  } else if (!status) {
    text = `The AI agent uses up to ${DEFAULT_CONTEXT_SIZE} tokens unless you set a size.`;
  } else {
    switch (status.kind) {
      case "native": {
        const trained = status.trainedMax ?? null;
        const requested = props.setting ?? DEFAULT_CONTEXT_SIZE;
        const effective =
          trained !== null ? Math.min(requested, trained) : requested;
        text = `Ollama ${status.version ?? ""}. Agent context: ${effective} tokens${
          trained !== null ? ` (model max ${trained})` : ""
        }.`;
        break;
      }
      case "native_no_model":
        text = "Choose a model to see its context size.";
        break;
      case "metadata_unavailable":
        text =
          "Couldn't read this model's context size; the agent won't run until it can.";
        break;
      case "model_not_found":
        text = "Model not found on this server.";
        break;
      case "too_old":
        text = "Update Ollama to 0.12.6 or newer to use the AI agent.";
        break;
      case "compatible":
        text = "Context size can't be set for this server.";
        break;
      case "unreachable":
        text = "Couldn't reach the server.";
        break;
      default:
        text = "";
    }
  }
  if (!text) return null;
  return (
    <div class="text-xs text-neutral-500" aria-live="polite">
      {text}
    </div>
  );
}
