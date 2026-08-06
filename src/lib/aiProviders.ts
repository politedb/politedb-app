import type { AiProviderConfig, AiProviderKind } from "src/types";
import {
  aiProviderDelete,
  aiProviderList as tauriAiProviderList,
  aiProviderSaveConfig,
  aiProviderTest,
} from "src/lib/tauri/ai";

const AI_SELECTED_PROVIDER_KEY = "politedb.ai.provider.selected";

export const DEFAULT_LOCAL_AI_PROVIDER_ID = "local";
export const LOCAL_AI_PROVIDER_KINDS: AiProviderKind[] = [
  "ollama",
  "local_openai_compatible",
];

export const AI_PROVIDER_LABELS: Record<AiProviderKind, string> = {
  ollama: "Ollama",
  local_openai_compatible: "Local API",
};

export const DEFAULT_MODELS: Record<AiProviderKind, string> = {
  ollama: "qwen2.5-coder:7b",
  local_openai_compatible: "qwen2.5-coder:7b",
};

export const DEFAULT_HOSTS: Record<AiProviderKind, string> = {
  ollama: "http://127.0.0.1:11434",
  local_openai_compatible: "http://127.0.0.1:11434",
};

export const DEFAULT_SUB_PATHS: Record<AiProviderKind, string> = {
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
  return {
    id: overrides.id ?? makeId(kind),
    kind,
    label: overrides.label ?? AI_PROVIDER_LABELS[kind],
    host,
    subPath,
    baseUrl: overrides.baseUrl ?? buildBaseUrl(host, subPath),
    defaultModel: overrides.defaultModel ?? DEFAULT_MODELS[kind],
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
  return {
    ...provider,
    kind,
    label: provider.label || AI_PROVIDER_LABELS[kind],
    host,
    subPath,
    baseUrl: buildBaseUrl(host, subPath),
    defaultModel: provider.defaultModel || DEFAULT_MODELS[kind],
  };
}

export function getSelectedAiProviderId() {
  return DEFAULT_LOCAL_AI_PROVIDER_ID;
}

export function setSelectedAiProviderId(providerId: string) {
  void providerId;
  try {
    localStorage.setItem(
      AI_SELECTED_PROVIDER_KEY,
      DEFAULT_LOCAL_AI_PROVIDER_ID
    );
    window.dispatchEvent(
      new CustomEvent("politedb-ai-provider-selected", {
        detail: { providerId: DEFAULT_LOCAL_AI_PROVIDER_ID },
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
  const parts = splitBaseUrl(args.endpoint, "ollama");
  const next: AiProviderConfig = {
    id: DEFAULT_LOCAL_AI_PROVIDER_ID,
    kind: "ollama",
    label: "Ollama",
    host: parts.host,
    subPath: parts.subPath,
    baseUrl: args.endpoint.trim().replace(/\/+$/, ""),
    defaultModel: args.model.trim() || DEFAULT_MODELS.ollama,
    enabled: true,
  };

  if (
    existing?.baseUrl === next.baseUrl &&
    existing?.defaultModel === next.defaultModel &&
    existing?.enabled
  ) {
    return existing;
  }

  return aiProviderSaveConfig(next);
}

export async function saveAiProviderWithOptionalKey(args: {
  config: AiProviderConfig;
}) {
  if (!isLocalAiProviderKind(args.config.kind)) {
    throw new Error("Only local AI providers are supported.");
  }
  const config = {
    ...args.config,
    baseUrl:
      args.config.baseUrl ??
      buildBaseUrl(args.config.host, args.config.subPath),
  };
  return aiProviderSaveConfig(config);
}

export { aiProviderDelete, aiProviderSaveConfig, aiProviderTest };

export async function aiProviderList() {
  const providers = await tauriAiProviderList();
  return providers.filter((provider) => isLocalAiProviderKind(provider.kind));
}
