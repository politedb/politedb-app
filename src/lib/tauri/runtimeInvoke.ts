import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { noteRuntimeError } from "./runtimeAdmission";

/** The runtime connection a command acts on, whatever its argument shape. */
function runtimeIdOf(args?: InvokeArgs): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const a = args as Record<string, unknown>;
  const nested = (key: string) => {
    const value = a[key];
    return value && typeof value === "object"
      ? ((value as Record<string, unknown>).connection_id ??
          (value as Record<string, unknown>).connectionId)
      : undefined;
  };
  const id =
    a.connectionId ?? a.connection_id ?? nested("input") ?? nested("payload");
  return typeof id === "string" ? id : undefined;
}

/**
 * `invoke` for commands on a runtime connection: a backend refusal of a
 * stale connection (plan tab-database-reconnect R20) is reported once,
 * centrally, before the error reaches the caller.
 */
export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    throw noteRuntimeError(runtimeIdOf(args), err);
  }
}
