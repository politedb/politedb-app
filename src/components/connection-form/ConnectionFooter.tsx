import { cn } from "src/utils/cn";
import { Button } from "../common/Button";

type Status =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "connecting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function isBusy(status: Status) {
  return status.kind === "testing" || status.kind === "connecting";
}

function Spinner() {
  return (
    <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
  );
}

export function ConnectionFooter(props: {
  status: Status;
  requiredOk: boolean;
  storeKeychain: boolean;

  onTest: () => void;
  onConnect: () => void;
}) {
  const { status, requiredOk, storeKeychain, onTest, onConnect } = props;
  const busy = isBusy(status);

  return (
    <>
      {/* Footer */}
      <div class="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-4">
        <div class="flex items-center justify-between">
          {/* LEFT: Status */}
          <div class="flex items-center gap-2 text-sm">
            {status.kind === "idle" && (
              <>
                <span class="h-2 w-2 rounded-full bg-slate-400" />
                <span class="text-slate-500">
                  {!requiredOk
                    ? "Required: Host, Port, Database, User."
                    : storeKeychain
                      ? "Tip: In Keychain mode, Test may fail if password isn’t resolved."
                      : "Ready"}
                </span>
              </>
            )}

            {status.kind === "testing" && (
              <>
                <Spinner />
                <span class="font-medium text-blue-600">Testing…</span>
              </>
            )}

            {status.kind === "connecting" && (
              <>
                <Spinner />
                <span class="font-medium text-blue-600">Connecting…</span>
              </>
            )}

            {status.kind === "success" && (
              <>
                <span class="h-2 w-2 rounded-full bg-green-500" />
                <span class="font-medium text-green-600">{status.message}</span>
              </>
            )}

            {status.kind === "error" && (
              <>
                <span class="h-2 w-2 rounded-full bg-rose-500" />
                <span class="font-medium text-rose-700">Error</span>
              </>
            )}
          </div>

          {/* RIGHT: Actions */}
          <div class="flex gap-3">
            <Button
              variant="shadow"
              className="text-sm"
              disabled={busy || !requiredOk}
              onClick={onTest}
            >
              Test
            </Button>

            <Button
              variant="default"
              className="text-sm"
              disabled={busy || !requiredOk}
              onClick={onConnect}
            >
              Save & Connect
            </Button>
          </div>
        </div>
      </div>

      {/* Error detail – ONLY when error */}
      {status.kind === "error" ? (
        <div
          class={cn(
            "mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700"
          )}
        >
          {status.message}
        </div>
      ) : null}
    </>
  );
}
