import { runtimeRefusalOf } from "src/stores/runtimeTargets";

/*
 * Backend refusals of a stale runtime connection (plan
 * tab-database-reconnect R20) reach one handler, registered by the
 * connection layer, whatever wrapper saw them.
 */

type RefusalHandler = (
  runtimeId: string,
  reason: "RUNTIME_STALE" | "RUNTIME_IDENTITY_MISSING"
) => void;

let handler: RefusalHandler | null = null;

export function setRuntimeRefusalHandler(next: RefusalHandler | null): void {
  handler = next;
}

type DispatchGuard = (cmd: string, runtimeId: string) => void;

let dispatchGuard: DispatchGuard | null = null;

/**
 * The check every command on a runtime connection passes right before it is
 * sent (plan tab-database-reconnect D3); it throws to refuse.
 */
export function setRuntimeDispatchGuard(next: DispatchGuard | null): void {
  dispatchGuard = next;
}

export function guardRuntimeDispatch(cmd: string, runtimeId: string): void {
  dispatchGuard?.(cmd, runtimeId);
}

/** Reports `err` when it is a refusal of `runtimeId`; returns it unchanged. */
export function noteRuntimeError(runtimeId: string | undefined, err: unknown) {
  const reason = runtimeRefusalOf(err);
  if (reason && runtimeId) handler?.(runtimeId, reason);
  return err;
}

/** `call` on `runtimeId`, reporting a refusal before rethrowing it. */
export async function onRuntime<T>(
  runtimeId: string | undefined,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw noteRuntimeError(runtimeId, err);
  }
}
