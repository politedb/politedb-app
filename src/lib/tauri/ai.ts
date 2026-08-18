import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";
import type { AiProviderConfig } from "src/types";

export type AiRuntimePhase =
  | "missing"
  | "stopped"
  | "starting"
  | "ready"
  | "error";

export type AiRuntimeStatus = {
  phase: AiRuntimePhase;
  endpoint?: string | null;
  model_name?: string | null;
  server_bin?: string | null;
  model_path?: string | null;
  pid?: number | null;
  managed_by_app: boolean;
  missing: string[];
  last_error?: string | null;
  model_downloaded_bytes?: number | null;
  model_total_bytes?: number | null;
};

export async function aiRuntimeStatus() {
  return invoke<AiRuntimeStatus>(CMD.aiRuntimeStatus);
}

export async function aiRuntimeStart() {
  return invoke<AiRuntimeStatus>(CMD.aiRuntimeStart);
}

export async function aiRuntimeStop() {
  return invoke<AiRuntimeStatus>(CMD.aiRuntimeStop);
}

export async function aiRuntimeDownloadDefaultModel() {
  return invoke<AiRuntimeStatus>(CMD.aiRuntimeDownloadDefaultModel);
}

export async function aiRuntimeCancelModelDownload() {
  return invoke<AiRuntimeStatus>(CMD.aiRuntimeCancelModelDownload);
}

export async function aiRuntimeDeleteDefaultModel() {
  return invoke<AiRuntimeStatus>(CMD.aiRuntimeDeleteDefaultModel);
}

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

export async function aiProviderSaveConfig(config: AiProviderConfig) {
  return invoke<AiProviderConfig>(CMD.aiProviderSaveConfig, { config });
}

export async function aiProviderSetKey(providerId: string, apiKey: string) {
  return invoke<AiProviderConfig>(CMD.aiProviderSetKey, {
    providerId,
    apiKey,
  });
}

export async function aiProviderValidateConfig(
  config: AiProviderConfig,
  apiKey?: string
) {
  await invoke(CMD.aiProviderValidateConfig, {
    config,
    apiKey: apiKey?.trim() || null,
  });
}

export async function aiProviderDelete(providerId: string) {
  await invoke(CMD.aiProviderDelete, { providerId });
}

export async function aiProviderTest(providerId: string) {
  return invoke<string>(CMD.aiProviderTest, { providerId });
}

export async function aiChatComplete(request: AiChatCompleteRequest) {
  return invoke<string>(CMD.aiChatComplete, { request });
}
