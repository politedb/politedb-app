import { operationBus } from "./operationBus";
import { operationCancel, operationExecute } from "./operation";

/** Whole attempt, from before listener setup to an adopted operation id. */
export const EXPLAIN_ANALYZE_ATTEMPT_DEADLINE_MS = 100_000;
/** After adoption: the run ends as "no response" if nothing terminal arrives. */
export const EXPLAIN_ANALYZE_WATCHDOG_MS = 95_000;

export type ExplainAnalyzeStart =
  | { kind: "started"; opId: string }
  /** The backend refused before running anything. */
  | { kind: "refused"; reason: string }
  | { kind: "busy" }
  | { kind: "aborted" }
  | { kind: "timeout" }
  | { kind: "failed" };

type Deps = {
  ensureInit: () => Promise<void>;
  execute: typeof operationExecute;
  cancel: typeof operationCancel;
  now: () => number;
};

const defaultDeps: Deps = {
  ensureInit: () => operationBus.ensureInit(),
  execute: operationExecute,
  cancel: operationCancel,
  now: () => Date.now(),
};

type Race<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown };

/** Resolve with `promise`, or reject-free with "aborted"/"timeout". */
function raceAttempt<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
  now: () => number
): Promise<Race<T> | "aborted" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: Race<T> | "aborted" | "timeout") => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish("aborted");
    const timer = window.setTimeout(
      () => finish("timeout"),
      Math.max(0, deadlineAt - now())
    );
    if (signal.aborted) return finish("aborted");
    signal.addEventListener("abort", onAbort);
    promise.then(
      (value) => finish({ kind: "value", value }),
      (error) => finish({ kind: "error", error })
    );
  });
}

function startError(error: unknown): ExplainAnalyzeStart {
  const text = String((error as { message?: unknown })?.message ?? error ?? "");
  const refused = text.match(/EXPLAIN_ANALYZE_REFUSED:([a-z_]+)/);
  if (refused) return { kind: "refused", reason: refused[1]! };
  if (text.includes("EXPLAIN_ANALYZE_BUSY")) return { kind: "busy" };
  if (text.includes("EXPLAIN_ANALYZE_UNSUPPORTED_ENGINE"))
    return { kind: "refused", reason: "unsupported_engine" };
  return { kind: "failed" };
}

/**
 * Start one Explain Analyze operation (plan section 3, steps 7–8). Never
 * retries and never uses busy-retry. If the attempt is aborted or times out
 * before an id is adopted, any id that arrives later is cancelled right away
 * and nothing is published. `stillAllowed` re-checks the caller's policy
 * after listener setup, immediately before the IPC call.
 */
export async function startExplainAnalyzeOperation(
  args: {
    connectionId: string;
    sql: string;
    signal: AbortSignal;
    deadlineAt: number;
    stillAllowed: () => boolean;
  },
  deps: Deps = defaultDeps
): Promise<ExplainAnalyzeStart> {
  const { signal, deadlineAt } = args;
  if (signal.aborted) return { kind: "aborted" };

  const init = await raceAttempt(
    deps.ensureInit(),
    signal,
    deadlineAt,
    deps.now
  );
  if (init === "aborted" || init === "timeout") return { kind: init };
  if (init.kind === "error") return { kind: "failed" };
  if (signal.aborted) return { kind: "aborted" };
  if (!args.stillAllowed()) return { kind: "aborted" };

  let adopted = false;
  let abandoned = false;
  const start = deps.execute({
    connection_id: args.connectionId,
    kind: "explain_analyze",
    explain_analyze: { sql: args.sql },
  });
  // Detached continuation: an id that comes back after we gave up is
  // cancelled at once, whatever happened to this attempt meanwhile.
  start.then(
    (opId) => {
      if (abandoned && !adopted) void deps.cancel(opId).catch(() => {});
    },
    () => {}
  );

  const outcome = await raceAttempt(start, signal, deadlineAt, deps.now);
  if (outcome === "aborted" || outcome === "timeout") {
    abandoned = true;
    return { kind: outcome };
  }
  if (outcome.kind === "error") return startError(outcome.error);
  if (signal.aborted) {
    abandoned = true;
    void deps.cancel(outcome.value).catch(() => {});
    return { kind: "aborted" };
  }
  adopted = true;
  return { kind: "started", opId: outcome.value };
}
