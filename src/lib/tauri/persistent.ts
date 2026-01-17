import { invoke } from "@tauri-apps/api/core";
import { PersistentSnapshot } from "src/stores/persistentStore";
import { CMD } from "./commands";

export async function persistentLoad(): Promise<PersistentSnapshot | null> {
  return invoke<PersistentSnapshot | null>(CMD.persistentLoad);
}

export async function persistentSave(
  snapshot: PersistentSnapshot
): Promise<void> {
  return invoke<void>(CMD.persistentSave, { snapshot });
}

export async function persistentClear(): Promise<void> {
  return invoke<void>(CMD.persistentClear);
}
