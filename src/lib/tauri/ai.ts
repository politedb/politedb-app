import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";
import type { AiProviderConfig } from "src/types";

export type AiChatCompleteMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AiChatCompleteRequest = {
  providerId: string;
  model?: string | null;
  messages: AiChatCompleteMessage[];
  temperature?: number | null;
  maxTokens?: number | null;
};

export async function aiProviderList() {
  return invoke<AiProviderConfig[]>(CMD.aiProviderList);
}

/** Key edit sent with a save. `keep` (blank input) leaves the stored key untouched. */
export type AiProviderKeyChange =
  | { action: "keep" }
  | { action: "set"; value: string }
  | { action: "remove" };

/** Saves config and key change in one backend transaction (no network call). */
export async function aiProviderSave(
  config: AiProviderConfig,
  keyChange: AiProviderKeyChange
) {
  return invoke<AiProviderConfig>(CMD.aiProviderSave, { config, keyChange });
}

export async function aiProviderDelete(providerId: string) {
  await invoke(CMD.aiProviderDelete, { providerId });
}

/**
 * Model ids reported by the server for an unsaved draft (not license-gated).
 * `auth` mirrors the form: keep = stored key, set = typed key, remove = no key.
 * `requestId` scopes {@link aiProviderCancelListModels} to this caller's request.
 */
export async function aiProviderListModels(
  config: AiProviderConfig,
  auth: AiProviderKeyChange,
  requestId: string
) {
  return invoke<string[]>(CMD.aiProviderListModels, {
    config,
    auth,
    requestId,
  });
}

/** Cancels only the discovery started with `requestId`. */
export async function aiProviderCancelListModels(requestId: string) {
  try {
    await invoke<void>(CMD.aiProviderCancelListModels, { requestId });
  } catch {
    // Ignore when the desktop backend is unavailable (tests / web preview).
  }
}

export type OllamaStatusKind =
  | "native"
  | "native_no_model"
  | "metadata_unavailable"
  | "model_not_found"
  | "too_old"
  | "compatible"
  | "unreachable"
  | "not_ollama_kind";

export type OllamaStatus = {
  requestId: string;
  kind: OllamaStatusKind;
  version?: string | null;
  trainedMax?: number | null;
  /** The context size a run would send: min(setting or default, trainedMax). */
  effective?: number | null;
};

/**
 * What the server behind an (unsaved) Ollama draft supports. Persists nothing.
 * Cancel with {@link aiProviderCancelListModels} and the same `requestId`.
 */
export async function aiOllamaStatus(
  config: AiProviderConfig,
  requestId: string
) {
  return invoke<OllamaStatus>(CMD.aiOllamaStatus, { config, requestId });
}

/** Sends a short test completion for an unsaved draft; persists nothing. */
/** Cancel with `aiProviderCancelListModels(requestId)`; ends after 30 s otherwise. */
export async function aiProviderTestDraft(
  config: AiProviderConfig,
  auth: AiProviderKeyChange,
  requestId: string
) {
  await invoke(CMD.aiProviderTestDraft, { config, auth, requestId });
}

export type AiLegacyModelFile = { name: string; sizeBytes: number };
export type AiLegacyModelInfo = { files: AiLegacyModelFile[] };

/** Model files left by the removed built-in AI runtime. */
export async function aiLegacyModelInfo() {
  return invoke<AiLegacyModelInfo>(CMD.aiLegacyModelInfo);
}

/** Deletes those files; returns any that could not be deleted. */
export async function aiLegacyModelDelete() {
  return invoke<AiLegacyModelInfo>(CMD.aiLegacyModelDelete);
}

export async function aiChatComplete(request: AiChatCompleteRequest) {
  return invoke<string>(CMD.aiChatComplete, { request });
}

export async function aiChatCancel() {
  try {
    await invoke<void>(CMD.aiChatCancel);
  } catch {
    // Ignore when the desktop backend is unavailable (tests / web preview).
  }
}
