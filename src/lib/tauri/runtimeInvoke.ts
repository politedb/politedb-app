import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { guardRuntimeDispatch, noteRuntimeError } from "./runtimeAdmission";

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
    a.connectionId ??
    a.connection_id ??
    a.runtimeConnectionId ??
    nested("input") ??
    nested("payload");
  return typeof id === "string" ? id : undefined;
}

/**
 * `invoke` for commands on a runtime connection: the tab guard (D3) runs
 * right before it is sent, and a backend refusal of a stale connection
 * (plan tab-database-reconnect R20) is reported once, centrally, before the
 * error reaches the caller.
 */
export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  const runtimeId = runtimeIdOf(args);
  if (runtimeId) guardRuntimeDispatch(cmd, runtimeId);
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    throw noteRuntimeError(runtimeId, err);
  }
}
