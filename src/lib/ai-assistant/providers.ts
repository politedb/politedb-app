import type { AiProviderConfig, AiProviderKind } from "src/types";
import {
  aiProviderDelete as tauriAiProviderDelete,
  aiProviderList as tauriAiProviderList,
  aiProviderSave,
  aiProviderListModels,
  aiProviderCancelListModels,
  aiProviderTestDraft,
  type AiProviderKeyChange,
} from "src/lib/tauri/ai";

const AI_SELECTED_PROVIDER_KEY = "politedb.ai.provider.selected";

/** Id the removed built-in runtime used for its auto-created provider (plan D11). */
export const LEGACY_BUNDLED_PROVIDER_ID = "local";
const LEGACY_BUNDLED_PROVIDER_LABEL = "PoliteDB AI";
const LEGACY_NOTICE_DISMISSED_KEY = "politedb.ai.legacyLocalNotice.dismissed";

export const LOCAL_AI_PROVIDER_KINDS: AiProviderKind[] = ["ollama"];

export const AI_PROVIDER_LABELS: Record<AiProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google AI",
  openrouter: "OpenRouter",
  grok: "Grok",
  deepseek: "DeepSeek",
  github_copilot: "GitHub Copilot",
  groq: "Groq",
  ollama: "Ollama",
};

export const DEFAULT_MODELS: Record<AiProviderKind, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-2.5-flash",
  openrouter: "openai/gpt-4.1-mini",
  grok: "grok-3-mini",
  deepseek: "deepseek-chat",
  github_copilot: "gpt-4.1",
  groq: "openai/gpt-oss-120b",
  // Local servers expose whatever the user installed: pick via "Load models".
  ollama: "",
};

/**
 * Common model ids offered as suggestions in Settings. Not a whitelist: any id can be
 * typed, and "Load models" adds what the server actually reports.
 */
export const SUGGESTED_MODELS: Record<AiProviderKind, string[]> = {
  openai: [
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
    "o3",
  ],
  anthropic: [
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
  ],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  openrouter: [
    "openai/gpt-4.1-mini",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-flash",
    "deepseek/deepseek-chat",
  ],
  grok: ["grok-4", "grok-3", "grok-3-mini"],
  groq: [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  github_copilot: ["gpt-4.1", "gpt-4o", "gpt-4o-mini"],
  ollama: ["llama3.2", "qwen2.5-coder:7b", "mistral", "gemma3"],
};

export const DEFAULT_HOSTS: Record<AiProviderKind, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api",
  grok: "https://api.x.ai",
  deepseek: "https://api.deepseek.com",
  github_copilot: "https://models.inference.ai.azure.com",
  groq: "https://api.groq.com/openai",
  ollama: "http://127.0.0.1:11434",
};

export const DEFAULT_SUB_PATHS: Record<AiProviderKind, string> = {
  openai: "/v1",
  anthropic: "/v1",
  gemini: "/v1beta",
  openrouter: "/v1",
  grok: "/v1",
  deepseek: "/v1",
  github_copilot: "",
  groq: "/v1",
  ollama: "/v1",
};

export function isLocalAiProviderKind(kind: AiProviderKind) {
  return LOCAL_AI_PROVIDER_KINDS.includes(kind);
}

export type AiProviderKeyCapability = "required" | "none";

/** Mirrors the backend: cloud keys are required, Ollama uses none. */
export function aiProviderKeyCapability(
  kind: AiProviderKind
): AiProviderKeyCapability {
  if (kind === "ollama") return "none";
  return "required";
}

function makeId(kind: AiProviderKind) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${kind}-${Date.now().toString(36)}-${random}`;
}

export function makeDefaultAiProvider(
  kind: AiProviderKind,
  overrides: Partial<AiProviderConfig> = {}
): AiProviderConfig {
  const host = overrides.host ?? DEFAULT_HOSTS[kind];
  const subPath = overrides.subPath ?? DEFAULT_SUB_PATHS[kind];
  const defaultModel = overrides.defaultModel ?? DEFAULT_MODELS[kind];
  return {
    id: overrides.id ?? makeId(kind),
    kind,
    label: overrides.label ?? AI_PROVIDER_LABELS[kind],
    host,
    subPath,
    baseUrl: overrides.baseUrl ?? buildBaseUrl(host, subPath),
    defaultModel,
    models: overrides.models ?? (defaultModel ? [defaultModel] : []),
    enabled: overrides.enabled ?? true,
    isDefault: overrides.isDefault ?? false,
  };
}

export function buildBaseUrl(host?: string | null, subPath?: string | null) {
  const h = (host ?? "").trim().replace(/\/+$/, "");
  const p = (subPath ?? "").trim();
  if (!h) return null;
  if (!p) return h;
  return `${h}${p.startsWith("/") ? p : `/${p}`}`.replace(/\/+$/, "");
}

export function splitBaseUrl(baseUrl?: string | null, kind?: AiProviderKind) {
  const fallbackKind = kind ?? "ollama";
  const raw = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!raw) {
    return {
      host: DEFAULT_HOSTS[fallbackKind],
      subPath: DEFAULT_SUB_PATHS[fallbackKind],
    };
  }
  for (const suffix of ["/v1beta", "/v1"]) {
    if (raw.endsWith(suffix)) {
      return {
        host: raw.slice(0, -suffix.length),
        subPath: suffix,
      };
    }
  }
  return { host: raw, subPath: DEFAULT_SUB_PATHS[fallbackKind] };
}

export function normalizeAiProviderConfig(
  provider: AiProviderConfig
): AiProviderConfig {
  const kind = provider.kind;
  const parts = splitBaseUrl(provider.baseUrl, kind);
  const host = provider.host ?? parts.host;
  const subPath = provider.subPath ?? parts.subPath;
  // Model ids are kept exactly as saved or reported by the server (plan R2).
  const defaultModel = provider.defaultModel.trim() || DEFAULT_MODELS[kind];
  const models = Array.from(
    new Set(
      [...(provider.models ?? []), defaultModel]
        .map((model) => model.trim())
        .filter(Boolean)
    )
  );
  return {
    ...provider,
    kind,
    label:
      !provider.label || provider.label === "Local API"
        ? AI_PROVIDER_LABELS[kind]
        : provider.label,
    host,
    subPath,
    baseUrl: buildBaseUrl(host, subPath),
    defaultModel,
    models,
  };
}

/** Selected → default → first, considering enabled providers only (plan R5). */
export function resolveSelectedAiProvider(
  providers: AiProviderConfig[],
  selectedId?: string | null
): AiProviderConfig | undefined {
  const enabled = providers.filter((provider) => provider.enabled);
  const selected = selectedId?.trim();
  return (
    (selected
      ? enabled.find((provider) => provider.id === selected)
      : undefined) ??
    enabled.find((provider) => provider.isDefault) ??
    enabled[0]
  );
}

export function getSelectedAiProviderId() {
  try {
    return localStorage.getItem(AI_SELECTED_PROVIDER_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Persists the selection; an empty id clears it. Always notifies open panels. */
export function setSelectedAiProviderId(providerId: string) {
  const next = providerId.trim();
  try {
    if (next) localStorage.setItem(AI_SELECTED_PROVIDER_KEY, next);
    else localStorage.removeItem(AI_SELECTED_PROVIDER_KEY);
  } catch {}
  try {
    window.dispatchEvent(
      new CustomEvent("politedb-ai-provider-selected", {
        detail: { providerId: next },
      })
    );
  } catch {}
}

/**
 * True for a provider that looks like the one the removed built-in runtime created
 * (plan D11). Display hint only: such records are never modified.
 */
export function isLegacyBundledProvider(provider: AiProviderConfig) {
  if (
    provider.id !== LEGACY_BUNDLED_PROVIDER_ID ||
    provider.kind !== "ollama" ||
    provider.label !== LEGACY_BUNDLED_PROVIDER_LABEL
  ) {
    return false;
  }
  const raw = provider.baseUrl ?? buildBaseUrl(provider.host, provider.subPath);
  try {
    const url = new URL(raw ?? "");
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return (
      url.protocol === "http:" &&
      loopback &&
      url.port !== "" &&
      url.port !== "11434" &&
      url.pathname.replace(/\/+$/, "") === "/v1"
    );
  } catch {
    return false;
  }
}

export function isLegacyLocalNoticeDismissed() {
  try {
    return localStorage.getItem(LEGACY_NOTICE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissLegacyLocalNotice() {
  try {
    localStorage.setItem(LEGACY_NOTICE_DISMISSED_KEY, "1");
  } catch {}
}

export async function saveAiProvider(args: {
  config: AiProviderConfig;
  keyChange: AiProviderKeyChange;
}) {
  const config = {
    ...args.config,
    baseUrl:
      args.config.baseUrl ??
      buildBaseUrl(args.config.host, args.config.subPath),
  };
  try {
    const saved = await aiProviderSave(config, args.keyChange);
    window.dispatchEvent(new Event("politedb-ai-providers-changed"));
    return saved;
  } catch (error) {
    // The disk may now hold the new config (rollback failed): make every open panel
    // reload from disk instead of trusting its in-memory copy (plan R13).
    if (String(error).includes("AI_PROVIDER_SAVE_ROLLBACK_FAILED")) {
      window.dispatchEvent(new Event("politedb-ai-providers-changed"));
    }
    throw error;
  }
}

export async function aiProviderDelete(providerId: string) {
  await tauriAiProviderDelete(providerId);
  window.dispatchEvent(new Event("politedb-ai-providers-changed"));
}

export {
  aiProviderListModels,
  aiProviderCancelListModels,
  aiProviderTestDraft,
};
export type { AiProviderKeyChange };

export async function aiProviderList() {
  return tauriAiProviderList();
}
