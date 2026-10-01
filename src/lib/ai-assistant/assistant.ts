import type { LocalAiSettings } from "src/lib/ai-assistant/types";

export const AI_ENDPOINT_KEY = "politedb.ai.endpoint";
export const AI_MODEL_KEY = "politedb.ai.model";
export const AI_MODEL_SEEN_KEY = "politedb.ai.model.seen";

export const MODEL_LOADING_MAX_RETRIES = 20;
export const MODEL_LOADING_RETRY_MS = 1500;
export const DEFAULT_AI_MODEL_NAME = "Qwen2.5-Coder-7B";

export function normalizeLocalAiModelName(model?: string | null) {
  const value = model?.trim() ?? "";
  const normalized = value.toLowerCase();
  if (
    !value ||
    normalized === "default" ||
    normalized === "default.gguf" ||
    normalized === "local-model" ||
    normalized.startsWith("llama-") ||
    normalized.includes("llama3") ||
    normalized.includes("llama-3")
  ) {
    return DEFAULT_AI_MODEL_NAME;
  }
  if (normalized.includes("qwen2.5-coder")) {
    return DEFAULT_AI_MODEL_NAME;
  }
  return value;
}

export const DEFAULT_AI_SETTINGS: LocalAiSettings = {
  endpoint: "http://127.0.0.1:11434",
  model: DEFAULT_AI_MODEL_NAME,
};
