import type { LocalAiSettings } from "@root/src/lib/ai-assistant/types";

export const AI_ENDPOINT_KEY = "politedb.ai.endpoint";
export const AI_MODEL_KEY = "politedb.ai.model";
export const AI_MODEL_SEEN_KEY = "politedb.ai.model.seen";

export const MODEL_LOADING_MAX_RETRIES = 20;
export const MODEL_LOADING_RETRY_MS = 1500;

export const DEFAULT_AI_SETTINGS: LocalAiSettings = {
  endpoint: "http://127.0.0.1:11434",
  model: "qwen2.5-coder:7b",
};
