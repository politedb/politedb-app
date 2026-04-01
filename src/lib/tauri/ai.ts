import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

export type AiRuntimePhase = "missing" | "stopped" | "starting" | "ready" | "error";

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
