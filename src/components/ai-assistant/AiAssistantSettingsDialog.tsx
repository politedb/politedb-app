import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import {
  ChevronRightIcon,
  RefreshCwIcon,
  SparklesIcon,
  XIcon,
} from "src/components/icons";
import { openExternalUrl } from "src/lib/tauri/license";
import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDER_KEY_PAGES,
  DEFAULT_HOSTS,
  DEFAULT_SUB_PATHS,
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
import { describeProviderError } from "src/lib/ai-assistant/providerErrors";

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

/** One message under the form: what the last action did. */
type StatusLine = {
  tone: "info" | "success" | "error";
  message: string;
  /** Raw provider/backend code, shown small under an error. */
  code?: string;
};

const STATUS_TONE: Record<StatusLine["tone"], string> = {
  info: "border-neutral-200 bg-neutral-50 text-neutral-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-red-200 bg-red-50 text-red-800",
};

/** The fields a user edits, to tell whether the form differs from what is saved. */
function editableSnapshot(config: AiProviderConfig, kind: AiProviderKind) {
  return JSON.stringify({
    // A blank name saves as the provider's name: compare what would be saved.
    label: config.label.trim() || AI_PROVIDER_LABELS[kind],
    enabled: config.enabled,
    host: config.host ?? "",
    subPath: config.subPath ?? "",
    models: config.models ?? [],
    defaultModel: config.defaultModel,
    isDefault: Boolean(config.isDefault),
    contextSize: config.contextSize ?? null,
  });
}

export function AiAssistantSettingsDialog(props: Props) {
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [selectedKind, setSelectedKind] = useState<AiProviderKind>("openai");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => makeDefaultAiProvider("openai"));
  const [apiKey, setApiKey] = useState("");
  /** Typing a new key over a saved one. */
  const [replacingKey, setReplacingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  /** Host and sub path shown (always for local servers). */
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Ids the server reported on the last discovery, offered again as suggestions.
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [status, setStatusLine] = useState<StatusLine | null>(null);
  /** Plain progress or info text; empty clears the line. */
  const setStatus = (message: string) =>
    setStatusLine(message ? { tone: "info", message } : null);
  const showError = (error: unknown, model?: string) =>
    setStatusLine(describeProviderError(error, { model }));
  /** Save or delete in progress. */
  const [busy, setBusy] = useState(false);
  /** A Test request is running; it can be cancelled. */
  const [testing, setTesting] = useState(false);
  const testTokenRef = useRef(0);
  const testIdRef = useRef<string | null>(null);
  /** The editable fields as last loaded or saved, to detect unsaved changes. */
  const [savedSnapshot, setSavedSnapshot] = useState("");
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

  /** Abandons a running Test: its answer no longer matches the form. */
  const cancelTest = () => {
    testTokenRef.current += 1;
    setTesting(false);
    const requestId = testIdRef.current;
    testIdRef.current = null;
    if (requestId) void aiProviderCancelListModels(requestId);
  };

  /** Any edit makes the shown result, a running Test and an open discard question stale. */
  const markEdited = () => {
    if (testIdRef.current) cancelTest();
    setStatusLine(null);
    if (discardResolveRef.current) answerDiscard(false);
  };

  /** The open question in the dialog (discard edits, delete), and how to answer it. */
  const [discardPrompt, setDiscardPrompt] = useState<{
    message: string;
    confirmLabel: string;
  } | null>(null);
  const discardResolveRef = useRef<((discard: boolean) => void) | null>(null);
  /** Where focus was when the question opened; Keep editing returns there. */
  const discardReturnFocusRef = useRef<HTMLElement | null>(null);
  const answerDiscard = (discard: boolean) => {
    const resolve = discardResolveRef.current;
    discardResolveRef.current = null;
    setDiscardPrompt(null);
    const returnTo = discardReturnFocusRef.current;
    discardReturnFocusRef.current = null;
    if (!discard && returnTo?.isConnected) {
      // After the bar is replaced by the action buttons, not onto them.
      queueMicrotask(() => returnTo.focus());
    }
    resolve?.(discard);
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
    setReplacingKey(false);
    setShowKey(false);
  };

  const chooseProvider = (
    kind: AiProviderKind,
    provider?: AiProviderConfig
  ) => {
    invalidateDiscovery();
    invalidateStatus();
    cancelTest();
    const next = normalizeAiProviderConfig(
      provider ?? makeDefaultAiProvider(kind)
    );
    setSelectedKind(kind);
    setSelectedId(provider?.id ?? null);
    setDraft(next);
    setSavedSnapshot(editableSnapshot(next, kind));
    // Open Advanced when the address differs from the provider's default.
    setShowAdvanced(
      (next.host ?? "") !== DEFAULT_HOSTS[kind] ||
        (next.subPath ?? "") !== DEFAULT_SUB_PATHS[kind]
    );
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
      cancelTest();
      answerDiscard(false);
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
      .catch((error) => showError(error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const updateDraft = (patch: Partial<AiProviderConfig>) => {
    markEdited();
    setDraft((current) => ({ ...current, ...patch }));
  };

  /** Merges into the latest draft so edits made while a request was running survive. */
  const addModels = (ids: string[]) => {
    // The first model added becomes the default: the shown status is then stale.
    const firstDefault = draft.defaultModel.trim()
      ? null
      : (ids.map((id) => id.trim()).find(Boolean) ?? null);
    if (firstDefault) defaultModelChanged(firstDefault);
    markEdited();
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

  /**
   * The key used for requests changed (cancel a replacement, remove, undo):
   * models found or errors seen with the previous key no longer apply.
   */
  const changeKeyAuth = (apply: () => void) => {
    invalidateDiscovery();
    setDiscoveredModels([]);
    setServerHint(null);
    markEdited();
    apply();
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
    // Even an invalid value makes a shown result and a running Test stale.
    markEdited();
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
    if (apiKey.trim()) return { action: "set", value: apiKey.trim() };
    return { action: "keep" };
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
        showError(error);
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
    // A model list still loading would land on a form that is being saved.
    invalidateDiscovery();
    setBusy(true);
    setStatus("Saving provider...");
    try {
      const saved = await saveAiProvider({
        config: draftConfig(),
        keyChange: keyChange(),
      });
      if (saved.isDefault && saved.enabled) setSelectedAiProviderId(saved.id);
      const next = await loadProviders();
      const normalized = normalizeAiProviderConfig(
        next.find((item) => item.id === saved.id) ?? saved
      );
      setSelectedId(saved.id);
      setDraft(normalized);
      setSavedSnapshot(editableSnapshot(normalized, normalized.kind));
      clearSecrets();
      setStatusLine({
        tone: "success",
        message: saved.apiKeyRef
          ? "Provider saved. API key is stored in the OS keychain."
          : "Provider saved.",
      });
    } catch (error) {
      showError(error);
      if (String(error).includes("AI_PROVIDER_SAVE_ROLLBACK_FAILED")) {
        // Show what is actually on disk now; never write again from here.
        const next = await loadProviders().catch(() => null);
        const onDisk = next?.find((item) => item.id === draftConfig().id);
        if (onDisk) {
          const reloaded = normalizeAiProviderConfig(onDisk);
          setDraft(reloaded);
          setSavedSnapshot(editableSnapshot(reloaded, reloaded.kind));
          // The context field is typed separately: show what is on disk too.
          setContextInput(
            reloaded.contextSize ? String(reloaded.contextSize) : ""
          );
          setContextError(null);
        }
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
    cancelTest();
    const token = testTokenRef.current;
    const requestId = `${instanceIdRef.current}:test:${token}`;
    testIdRef.current = requestId;
    setTesting(true);
    setStatus("Testing provider...");
    const unsaved = dirty;
    const model = draft.defaultModel;
    try {
      await aiProviderTestDraft(draftConfig(), keyChange(), requestId);
      if (token !== testTokenRef.current) return;
      setStatusLine({
        tone: "success",
        // A passing test does not keep anything: say so while edits are unsaved.
        message: unsaved
          ? "Test passed. Save to keep these settings."
          : "Provider connection succeeded.",
      });
      if (selectedKind === "ollama") void loadOllamaStatus(draftConfig());
    } catch (error) {
      if (token !== testTokenRef.current) return;
      showError(error, model);
    } finally {
      if (token === testTokenRef.current) {
        setTesting(false);
        testIdRef.current = null;
      }
    }
  };

  const stopTest = () => {
    cancelTest();
    setStatus("Test cancelled.");
  };

  const deleteProvider = async () => {
    if (!selectedProvider) return;
    const confirmed = await askInDialog(
      `Delete ${selectedProvider.label}? Its API key is removed from the keychain too.`,
      "Delete"
    );
    if (!confirmed) return;
    invalidateDiscovery();
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
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const deleteLegacyModel = async () => {
    const confirmed = await askInDialog(
      "Delete the AI model downloaded by earlier PoliteDB versions? This frees disk space and cannot be undone.",
      "Delete"
    );
    if (!confirmed) return;
    try {
      const remaining = await aiLegacyModelDelete();
      setStatusLine(
        remaining.files.length
          ? {
              tone: "error",
              message: `Could not delete: ${remaining.files.map((f) => f.name).join(", ")}`,
            }
          : { tone: "success", message: "Old built-in AI model deleted." }
      );
    } catch (error) {
      showError(error);
    } finally {
      void refreshLegacyModel();
    }
  };

  /** Edits not saved yet: a typed key, an invalid context size, or changed fields. */
  const dirty =
    apiKey.trim() !== "" ||
    contextError !== null ||
    editableSnapshot(draft, selectedKind) !== savedSnapshot;

  /**
   * Asks a yes/no question in the dialog (no native alert: its default button
   * would be the destructive one). The safe answer has focus, so Return and
   * Escape keep things as they are. One question at a time: another close or
   * switch while it is open answers no.
   */
  const askInDialog = (message: string, confirmLabel: string) => {
    if (discardResolveRef.current) {
      answerDiscard(false);
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      discardResolveRef.current = resolve;
      discardReturnFocusRef.current = document.activeElement as HTMLElement;
      setDiscardPrompt({ message, confirmLabel });
    });
  };

  /** Resolves true when it is fine to leave the current form. */
  const confirmDiscard = (): Promise<boolean> => {
    if (!dirty) return Promise.resolve(true);
    const name = draft.label.trim() || AI_PROVIDER_LABELS[selectedKind];
    return askInDialog(
      `Your changes to ${name} are not saved. Discard them?`,
      "Discard"
    );
  };

  const switchProvider = async (
    kind: AiProviderKind,
    provider?: AiProviderConfig
  ) => {
    // A save or delete in progress cannot be discarded: wait for it.
    if (busy) return;
    if (kind === selectedKind && (provider?.id ?? null) === selectedId) return;
    if (await confirmDiscard()) chooseProvider(kind, provider);
  };

  const requestClose = async () => {
    if (busy) return;
    if (await confirmDiscard()) props.onClose();
  };

  // Unmounting settles what the closed-prop path settles: no Test keeps
  // running and no question stays open.
  useEffect(
    () => () => {
      cancelTest();
      answerDiscard(false);
    },
    []
  );

  const discardBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!discardPrompt) return;
    discardBarRef.current
      ?.querySelector<HTMLButtonElement>("[data-default-action]")
      ?.focus();
  }, [discardPrompt]);

  const legacyModelBytes =
    legacyModel?.files.reduce((sum, file) => sum + file.sizeBytes, 0) ?? 0;

  const keyPage = DISTRIBUTION_FEATURES.providerKeyLinks
    ? AI_PROVIDER_KEY_PAGES[selectedKind]
    : undefined;
  const keyInputShown = !draft.apiKeyRef || replacingKey;
  const requestUrl = buildBaseUrl(draft.host, draft.subPath);

  const hostFields = (
    <div class="space-y-2">
      <div class="grid gap-3 sm:grid-cols-2">
        <Input
          label="Host"
          value={draft.host ?? ""}
          placeholder={
            isLocal ? "http://127.0.0.1:11434" : DEFAULT_HOSTS[selectedKind]
          }
          onValueChange={(value) => updateConnection({ host: value })}
          onBlur={reloadModelsAfterUrlEdit}
          className="h-10 border border-neutral-300 px-3 text-sm"
        />
        <Input
          label="Sub Path"
          value={draft.subPath ?? ""}
          placeholder={DEFAULT_SUB_PATHS[selectedKind] || undefined}
          onValueChange={(value) => updateConnection({ subPath: value })}
          onBlur={reloadModelsAfterUrlEdit}
          className="h-10 border border-neutral-300 px-3 text-sm"
        />
      </div>
      <div class="text-xs break-all text-neutral-500">
        Requests go to {requestUrl || "—"}
      </div>
      {isLocal ? (
        <div class="text-xs text-neutral-500">
          Plain http works for localhost and LAN IP addresses (for example
          192.168.1.20). Other hosts need https.
        </div>
      ) : null}
    </div>
  );

  return (
    <Dialog
      open={props.open}
      onClose={() => void requestClose()}
      size="xl"
      className="max-w-4xl overflow-hidden"
    >
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle className="flex items-center gap-2">
          <SparklesIcon className="size-4.5" />
          AI Provider Settings
        </DialogTitle>
        <DialogDescription className="text-xs text-neutral-500">
          API keys stay in the OS keychain. Chat history is stored on this
          device without encryption.
        </DialogDescription>
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
              const on = configured.some((provider) => provider.enabled);
              const isDefault = configured.some(
                (provider) => provider.isDefault && provider.enabled
              );
              const state = !configured.length
                ? "Not set up"
                : on
                  ? "On"
                  : "Off";
              return (
                <div key={kind}>
                  <button
                    type="button"
                    disabled={busy}
                    title={`${AI_PROVIDER_LABELS[kind]}: ${state}${isDefault ? ", default" : ""}`}
                    class={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium",
                      active
                        ? "bg-blue-600 text-white"
                        : "text-neutral-700 hover:bg-neutral-200"
                    )}
                    onClick={() => void switchProvider(kind, configured[0])}
                  >
                    <span class="min-w-0 flex-1 truncate">
                      {AI_PROVIDER_LABELS[kind]}
                    </span>
                    {isDefault ? (
                      <span
                        class={cn(
                          "shrink-0 rounded px-1.5 text-[10px] font-semibold tracking-wide uppercase",
                          active
                            ? "bg-white/20 text-white"
                            : "bg-blue-50 text-blue-700"
                        )}
                      >
                        Default
                      </span>
                    ) : null}
                    {configured.length ? (
                      <span
                        aria-hidden="true"
                        class={cn(
                          "size-2 shrink-0 rounded-full",
                          on
                            ? "bg-emerald-400"
                            : "border border-neutral-400 bg-transparent"
                        )}
                      />
                    ) : null}
                    <span class="sr-only">{state}</span>
                  </button>
                  {active && configured.length > 1 ? (
                    <div class="mt-1 ml-3 space-y-1">
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
                          onClick={() => void switchProvider(kind, provider)}
                        >
                          {provider.label}
                          {provider.enabled ? "" : " (off)"}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {active && configured.length > 0 ? (
                    <button
                      type="button"
                      class={cn(
                        "mt-1 ml-3 block rounded px-2 py-1 text-left text-xs",
                        selectedId === null
                          ? "font-semibold text-neutral-800"
                          : "text-neutral-500 hover:text-neutral-800"
                      )}
                      onClick={() => void switchProvider(kind)}
                    >
                      + Add another
                    </button>
                  ) : null}
                </div>
              );
            })}
          </OverlayScrollArea>
        </aside>

        <main class="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {/* The form scrolls; the action bar below stays pinned to the bottom. */}
          <OverlayScrollArea className="min-h-0 flex-1" contentClassName="p-5">
            {/* Nothing is editable while a save or delete runs: what is shown
                must be what gets saved, and the unsaved-changes check relies on it. */}
            <fieldset
              disabled={busy}
              class="m-0 min-w-0 space-y-5 border-0 p-0"
            >
              {showLegacyNotice ? (
                <div class="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <span>
                    If this was PoliteDB's built-in AI, it has been removed.
                    Enter the URL of your own Ollama server and load its models.
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

              <div class="divide-y divide-neutral-200 rounded-lg border border-neutral-200">
                <ToggleRow
                  label="Enabled"
                  description="Offer this provider in the AI assistant."
                  checked={draft.enabled}
                  onChange={(enabled) => updateDraft({ enabled })}
                />
                <ToggleRow
                  label="Default provider"
                  description="Used when a chat has no provider chosen."
                  checked={Boolean(draft.isDefault)}
                  onChange={(isDefault) => updateDraft({ isDefault })}
                />
              </div>

              <Input
                label="Name"
                value={draft.label}
                placeholder={AI_PROVIDER_LABELS[selectedKind]}
                onValueChange={(value) => updateDraft({ label: value })}
                className="h-10 border border-neutral-300 px-3 text-sm"
              />

              {keyCapability !== "none" ? (
                <section class="space-y-1.5">
                  <div class="flex items-center justify-between">
                    <label
                      for="ai-provider-api-key"
                      class="text-sm font-medium text-neutral-900"
                    >
                      API key
                    </label>
                    {keyPage ? (
                      <button
                        type="button"
                        class="text-xs text-blue-600 hover:underline"
                        onClick={() => void openExternalUrl(keyPage)}
                      >
                        Get a key ↗
                      </button>
                    ) : AI_PROVIDER_KEY_PAGES[selectedKind] ? (
                      // This build cannot open external pages.
                      <span class="text-xs text-neutral-500">
                        Create a key in your {AI_PROVIDER_LABELS[selectedKind]}{" "}
                        account
                      </span>
                    ) : null}
                  </div>
                  {keyInputShown ? (
                    <div class="flex items-center gap-2">
                      <div class="min-w-0 flex-1">
                        <Input
                          id="ai-provider-api-key"
                          type={showKey ? "text" : "password"}
                          value={apiKey}
                          placeholder={
                            draft.apiKeyRef ? "New key" : "Paste your API key"
                          }
                          onValueChange={(value) =>
                            changeKeyAuth(() => setApiKey(value))
                          }
                          className="h-10 border border-neutral-300 px-3 text-sm"
                          right={
                            <Button
                              variant="ghost"
                              className="h-6 px-1 text-xs"
                              aria-pressed={showKey}
                              onClick={() => setShowKey((shown) => !shown)}
                            >
                              {showKey ? "Hide" : "Show"}
                            </Button>
                          }
                        />
                      </div>
                      {draft.apiKeyRef ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-8 px-2 py-0.5 text-xs"
                          onClick={() =>
                            changeKeyAuth(() => {
                              setApiKey("");
                              setShowKey(false);
                              setReplacingKey(false);
                            })
                          }
                        >
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    // Cloud providers always need a key (the backend refuses
                    // to save one without): it can be replaced, and removed
                    // only by deleting the provider.
                    <div class="flex h-10 items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 text-sm">
                      <span class="min-w-0 flex-1 truncate text-neutral-700">
                        Saved in the OS keychain
                      </span>
                      <button
                        type="button"
                        class="text-xs font-medium text-blue-600 hover:underline"
                        onClick={() => {
                          markEdited();
                          setReplacingKey(true);
                        }}
                      >
                        Replace
                      </button>
                    </div>
                  )}
                </section>
              ) : null}

              {isLocal ? hostFields : null}

              <section class="space-y-2">
                <div class="flex items-center justify-between">
                  <span class="block text-sm font-medium text-neutral-900">
                    Models
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="gap-1 px-1.5 text-xs"
                    title="List the models this server or key can use"
                    aria-label="Reload models"
                    loading={loadingModels}
                    onClick={() => void loadModels()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    {isLocal ? null : "Load from provider"}
                  </Button>
                </div>
                <AiModelCombobox
                  suggestions={modelSuggestions}
                  selected={draft.models ?? []}
                  onAdd={(model) => addModels([model])}
                  focusRequest={pickerFocusRequest}
                  disabled={busy}
                />
                <div
                  role="radiogroup"
                  aria-label="Default model"
                  class="overflow-hidden rounded-lg border border-neutral-200"
                >
                  {(draft.models ?? []).length ? (
                    (draft.models ?? []).map((model) => (
                      <div
                        key={model}
                        class="flex min-w-0 items-center gap-2 border-b border-neutral-100 px-3 py-2 last:border-b-0"
                      >
                        <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="ai-default-model"
                            checked={draft.defaultModel === model}
                            onChange={() => setDefaultModel(model)}
                          />
                          <span class="min-w-0 truncate">{model}</span>
                        </label>
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
                        ? "No models yet. Load them from the provider, or type a model ID above."
                        : loadingModels
                          ? "Looking for models on the server..."
                          : discoveredModels.length
                            ? `${discoveredModels.length} model${discoveredModels.length === 1 ? "" : "s"} found on the server — pick from the list above.`
                            : (serverHint ??
                              "Start the server, then click Reload (↻) — or type a model ID above.")}
                    </div>
                  )}
                </div>
                {(draft.models ?? []).length > 1 ? (
                  <div class="text-xs text-neutral-500">
                    The selected model is the default; the others can be chosen
                    in the chat.
                  </div>
                ) : null}
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

              {!isLocal ? (
                <section class="space-y-2">
                  <button
                    type="button"
                    aria-expanded={showAdvanced}
                    class="flex items-center gap-1 text-sm font-medium text-neutral-700 hover:text-neutral-900"
                    onClick={() => setShowAdvanced((open) => !open)}
                  >
                    <span
                      aria-hidden="true"
                      class={cn(
                        "inline-block transition-transform",
                        showAdvanced && "rotate-90"
                      )}
                    >
                      <ChevronRightIcon className="size-3" />
                    </span>
                    Advanced
                    {showAdvanced ? null : (
                      <span class="ml-1 truncate text-xs font-normal text-neutral-500">
                        {requestUrl}
                      </span>
                    )}
                  </button>
                  {showAdvanced ? hostFields : null}
                </section>
              ) : null}

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
                <div
                  role={status.tone === "error" ? "alert" : "status"}
                  class={cn(
                    "rounded-lg border px-3 py-2 text-sm wrap-break-word",
                    STATUS_TONE[status.tone]
                  )}
                >
                  <div>{status.message}</div>
                  {status.code ? (
                    <div class="mt-1 font-mono text-xs opacity-70">
                      {status.code}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
          </OverlayScrollArea>
          {discardPrompt ? (
            <div
              ref={discardBarRef}
              role="alertdialog"
              aria-label={discardPrompt.message}
              class="flex shrink-0 items-center justify-between gap-3 border-t border-amber-200 bg-amber-50 px-5 py-3"
            >
              <span class="min-w-0 text-sm text-amber-900">
                {discardPrompt.message}
              </span>
              <div class="flex shrink-0 gap-2">
                <Button
                  data-default-action
                  variant="outline"
                  onClick={() => answerDiscard(false)}
                >
                  {discardPrompt.confirmLabel === "Discard"
                    ? "Keep editing"
                    : "Cancel"}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => answerDiscard(true)}
                >
                  {discardPrompt.confirmLabel}
                </Button>
              </div>
            </div>
          ) : (
            <div class="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 bg-white px-5 py-3">
              {selectedProvider ? (
                <Button
                  variant="ghost"
                  className="text-red-600 hover:border-rose-50 hover:bg-red-50"
                  onClick={() => void deleteProvider()}
                  disabled={busy || testing}
                >
                  Delete provider
                </Button>
              ) : (
                <span />
              )}
              <div class="flex gap-2">
                {testing ? (
                  <Button variant="outline" onClick={stopTest}>
                    Cancel test
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => void testProvider()}
                    disabled={busy || !draft.defaultModel.trim()}
                  >
                    Test
                  </Button>
                )}
                <Button
                  loading={busy}
                  disabled={testing}
                  onClick={() => void saveProvider()}
                >
                  Save
                </Button>
              </div>
            </div>
          )}
        </main>
      </DialogContent>
    </Dialog>
  );
}

/** A labelled on/off switch row. */
function ToggleRow(props: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div class="flex items-center justify-between gap-3 px-3 py-2.5">
      <div class="min-w-0">
        <div class="text-sm font-medium text-neutral-900">{props.label}</div>
        <div class="text-xs text-neutral-500">{props.description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        onClick={() => props.onChange(!props.checked)}
        class={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none disabled:opacity-50",
          props.checked
            ? "border-blue-600 bg-blue-600"
            : "border-neutral-300 bg-neutral-200"
        )}
      >
        <span
          class={cn(
            "inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
            props.checked ? "translate-x-6" : "translate-x-1"
          )}
        />
      </button>
    </div>
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
