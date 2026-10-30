import { invoke } from "./runtimeInvoke";
import { CMD } from "./commands";

export type SessionActionKind = "cancel" | "terminate";

/** Signal certainly not sent. */
export const PRE_DISPATCH_OUTCOMES = [
  "invalid",
  "unavailable",
  "busy",
  "setup_failed",
] as const;

/** Signal sent, refused, or not matched — PostgreSQL answered. */
export const DISPATCHED_OUTCOMES = [
  "signalled",
  "failed",
  "not_matched",
  "denied",
] as const;

export const SESSION_ACTION_OUTCOMES = [
  ...PRE_DISPATCH_OUTCOMES,
  ...DISPATCHED_OUTCOMES,
  "unknown",
] as const;

export type SessionActionOutcome = (typeof SESSION_ACTION_OUTCOMES)[number];

export type SessionActionTarget = {
  runtimeConnectionId: string;
  pid: number;
  backendToken: string;
  kind: SessionActionKind;
};

export function isSessionActionOutcome(
  value: unknown
): value is SessionActionOutcome {
  return (
    typeof value === "string" &&
    (SESSION_ACTION_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * Ask Rust to cancel the current query of, or terminate, another session.
 * Once the call is issued, any rejection or unexpected payload is "unknown":
 * only Rust's own structured answer proves the signal was not sent.
 */
export async function signalHealthInspectorBackend(
  target: SessionActionTarget,
  invokeFn: typeof invoke = invoke
): Promise<SessionActionOutcome> {
  if (
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    target.pid > 2_147_483_647 ||
    (target.kind !== "cancel" && target.kind !== "terminate")
  ) {
    return "invalid";
  }
  try {
    const result = await invokeFn<{ outcome?: unknown }>(
      CMD.healthInspectorSignalBackend,
      {
        runtimeConnectionId: target.runtimeConnectionId,
        pid: target.pid,
        backendToken: target.backendToken,
        kind: target.kind,
      }
    );
    return isSessionActionOutcome(result?.outcome) ? result.outcome : "unknown";
  } catch {
    return "unknown";
  }
}

let instanceAppName: Promise<string | null> | null = null;

/**
 * This running app's PostgreSQL application_name (`PoliteDB/<tag>`), used to
 * label "This app" rows. Null when unavailable: callers then hide actions.
 */
export function getPostgresInstanceAppName(
  invokeFn: typeof invoke = invoke
): Promise<string | null> {
  if (!instanceAppName) {
    instanceAppName = invokeFn<string>(CMD.postgresInstanceAppName)
      .then((name) =>
        typeof name === "string" && /^PoliteDB\/[0-9a-f]{8}$/.test(name)
          ? name
          : null
      )
      .catch(() => {
        // Retry on the next call rather than caching a failure.
        instanceAppName = null;
        return null;
      });
  }
  return instanceAppName;
}

/** Test helper. */
export function resetPostgresInstanceAppNameCache() {
  instanceAppName = null;
}
