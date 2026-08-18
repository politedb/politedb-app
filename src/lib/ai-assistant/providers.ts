import type { AiProviderConfig, AiProviderKind } from "src/types";
import {
  aiProviderDelete as tauriAiProviderDelete,
  aiProviderList as tauriAiProviderList,
  aiProviderSaveConfig,
  aiProviderSetKey,
  aiProviderValidateConfig,
  aiProviderTest,
} from "src/lib/tauri/ai";
import {
  DEFAULT_AI_MODEL_NAME,
  normalizeLocalAiModelName,
} from "src/utils/assistant";

const AI_SELECTED_PROVIDER_KEY = "politedb.ai.provider.selected";

export const DEFAULT_LOCAL_AI_PROVIDER_ID = "local";
export const LOCAL_AI_PROVIDER_KINDS: AiProviderKind[] = [
  "ollama",
  "local_openai_compatible",
];

export const AI_PROVIDER_LABELS: Record<AiProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google AI",
  openrouter: "OpenRouter",
  grok: "Grok",
  groq: "Groq",
  deepseek: "DeepSeek",
  github_copilot: "GitHub Models",
  ollama: "PoliteDB Local",
  local_openai_compatible: "PoliteDB Local",
};

export const DEFAULT_MODELS: Record<AiProviderKind, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-5",
  gemini: "gemini-2.5-flash",
  openrouter: "openai/gpt-4.1-mini",
  grok: "grok-3-mini",
  groq: "openai/gpt-oss-120b",
  deepseek: "deepseek-chat",
  github_copilot: "gpt-4.1",
  ollama: DEFAULT_AI_MODEL_NAME,
  local_openai_compatible: DEFAULT_AI_MODEL_NAME,
};

export const DEFAULT_HOSTS: Record<AiProviderKind, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api",
  grok: "https://api.x.ai",
  groq: "https://api.groq.com/openai",
  deepseek: "https://api.deepseek.com",
  github_copilot: "https://models.inference.ai.azure.com",
  ollama: "http://127.0.0.1:11434",
  local_openai_compatible: "http://127.0.0.1:11434",
};

export const DEFAULT_SUB_PATHS: Record<AiProviderKind, string> = {
  openai: "/v1",
  anthropic: "/v1",
  gemini: "/v1beta",
  openrouter: "/v1",
  grok: "/v1",
  groq: "/v1",
  deepseek: "/v1",
  github_copilot: "",
  ollama: "/v1",
  local_openai_compatible: "/v1",
};

export function isLocalAiProviderKind(kind: AiProviderKind) {
  return LOCAL_AI_PROVIDER_KINDS.includes(kind);
}

function makeId(kind: AiProviderKind) {
  return `${kind}-${Date.now().toString(36)}`;
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
    models: overrides.models ?? [defaultModel],
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
  const kind =
    provider.kind === "local_openai_compatible" ? "ollama" : provider.kind;
  const parts = splitBaseUrl(provider.baseUrl, kind);
  const host = provider.host ?? parts.host;
  const subPath = provider.subPath ?? parts.subPath;
  const defaultModel = isLocalAiProviderKind(kind)
    ? normalizeLocalAiModelName(provider.defaultModel)
    : provider.defaultModel.trim() || DEFAULT_MODELS[kind];
  const models = Array.from(
    new Set(
      [...(provider.models ?? []), defaultModel]
        .map((model) =>
          isLocalAiProviderKind(kind)
            ? normalizeLocalAiModelName(model)
            : model.trim()
        )
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

export function getSelectedAiProviderId() {
  try {
    return (
      localStorage.getItem(AI_SELECTED_PROVIDER_KEY)?.trim() ||
      DEFAULT_LOCAL_AI_PROVIDER_ID
    );
  } catch {
    return DEFAULT_LOCAL_AI_PROVIDER_ID;
  }
}

export function setSelectedAiProviderId(providerId: string) {
  const next = providerId.trim() || DEFAULT_LOCAL_AI_PROVIDER_ID;
  try {
    localStorage.setItem(AI_SELECTED_PROVIDER_KEY, next);
    window.dispatchEvent(
      new CustomEvent("politedb-ai-provider-selected", {
        detail: { providerId: next },
      })
    );
  } catch {}
}

export async function ensureLocalAiProvider(args: {
  endpoint: string;
  model: string;
}) {
  const providers = await aiProviderList().catch(() => []);
  const existing = providers.find(
    (item) => item.id === DEFAULT_LOCAL_AI_PROVIDER_ID
  );
  const hasDefaultProvider = providers.some((provider) => provider.isDefault);
  const parts = splitBaseUrl(args.endpoint, "ollama");
  const next: AiProviderConfig = {
    id: DEFAULT_LOCAL_AI_PROVIDER_ID,
    kind: "ollama",
    label: "PoliteDB AI",
    host: parts.host,
    subPath: parts.subPath,
    baseUrl: args.endpoint.trim().replace(/\/+$/, ""),
    defaultModel: DEFAULT_MODELS.ollama,
    models: [DEFAULT_MODELS.ollama],
    enabled: true,
    isDefault: hasDefaultProvider ? Boolean(existing?.isDefault) : true,
  };

  if (
    existing?.baseUrl === next.baseUrl &&
    existing?.defaultModel === next.defaultModel &&
    existing?.isDefault === next.isDefault &&
    existing?.enabled
  ) {
    return existing;
  }

  return aiProviderSaveConfig(next);
}

export async function saveAiProviderWithOptionalKey(args: {
  config: AiProviderConfig;
  apiKey?: string;
}) {
  const config = {
    ...args.config,
    baseUrl:
      args.config.baseUrl ??
      buildBaseUrl(args.config.host, args.config.subPath),
  };
  if (!isLocalAiProviderKind(config.kind)) {
    for (const model of config.models ?? [config.defaultModel]) {
      try {
        await aiProviderValidateConfig(
          { ...config, defaultModel: model },
          args.apiKey
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${model}: ${message}`);
      }
    }
  }
  const saved = await aiProviderSaveConfig(config);
  let result = saved;
  if (args.apiKey?.trim()) {
    result = await aiProviderSetKey(saved.id, args.apiKey.trim());
  }
  window.dispatchEvent(new Event("politedb-ai-providers-changed"));
  return result;
}

export async function aiProviderDelete(providerId: string) {
  await tauriAiProviderDelete(providerId);
  window.dispatchEvent(new Event("politedb-ai-providers-changed"));
}

export { aiProviderSaveConfig, aiProviderTest };

export async function aiProviderList() {
  return tauriAiProviderList();
}
