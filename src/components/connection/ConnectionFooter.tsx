import { useEffect, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { ErrorDialog } from "src/components/modal/ErrorDialog";
import { cn } from "src/utils/cn";

type Status =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "saving" }
  | { kind: "connecting" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function isBusy(status: Status) {
  return (
    status.kind === "testing" ||
    status.kind === "saving" ||
    status.kind === "connecting"
  );
}

function Spinner() {
  return (
    <span class="inline-block size-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
  );
}

function getIdleStatusMessage(options: {
  requiredOk: boolean;
  requiredHint?: string;
  storeKeychain: boolean;
}) {
  if (!options.requiredOk) {
    return options.requiredHint || "Required: Host, Port, User.";
  }
  if (options.storeKeychain) {
    return "Tip: In Keychain mode, Test may fail if password isn’t resolved.";
  }
  return "Ready";
}

export function ConnectionFooter(props: {
  className?: string;

  status: Status;
  requiredOk: boolean;
  storeKeychain: boolean;
  requiredHint?: string;

  onTest: () => void;
  onSave: () => void;
  onConnect: () => void;
}) {
  const {
    className,
    status,
    requiredOk,
    storeKeychain,
    requiredHint,
    onTest,
    onSave,
    onConnect,
  } = props;

  const busy = isBusy(status);
  const [openErrorDialog, setOpenErrorDialog] = useState(false);

  useEffect(() => {
    if (status.kind === "error") {
      setOpenErrorDialog(true);
    }
  }, [status.kind]);

  const statusNode = (() => {
    if (status.kind === "idle") {
      const msg = getIdleStatusMessage({
        requiredOk,
        requiredHint,
        storeKeychain,
      });
      return (
        <>
          <span class="h-2 w-2 rounded-full bg-slate-400" />
          <span class="text-slate-500">{msg}</span>
        </>
      );
    }

    if (status.kind === "testing") {
      return (
        <>
          <Spinner />
          <span class="font-medium text-blue-600">Testing…</span>
        </>
      );
    }

    if (status.kind === "saving") {
      return (
        <>
          <Spinner />
          <span class="font-medium text-blue-600">Saving…</span>
        </>
      );
    }

    if (status.kind === "connecting") {
      return (
        <>
          <Spinner />
          <span class="font-medium text-blue-600">Connecting…</span>
        </>
      );
    }

    if (status.kind === "success") {
      return (
        <>
          <span class="h-2 w-2 rounded-full bg-green-500" />
          <span class="font-medium text-green-600">{status.message}</span>
        </>
      );
    }

    return (
      <>
        <span class="size-2 shrink-0 rounded-full bg-rose-500" />
        <span class="font-medium text-rose-700">Error</span>
      </>
    );
  })();

  return (
    <>
      <div
        class={cn(
          "rounded-2xl border border-slate-200 bg-white px-5 py-4",
          className
        )}
      >
        <div class="flex items-center justify-between">
          {/* LEFT: Status */}
          <div class="flex items-center gap-2 text-sm">{statusNode}</div>

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
              variant="shadow"
              className="text-sm"
              disabled={busy || !requiredOk}
              onClick={onSave}
            >
              Save
            </Button>

            <Button
              variant="default"
              className="text-sm"
              disabled={busy || !requiredOk}
              onClick={onConnect}
            >
              Connect
            </Button>
          </div>
        </div>
      </div>

      {/* Error detail – ONLY when error */}
      {openErrorDialog && status.kind === "error" && (
        <ErrorDialog
          open={openErrorDialog}
          onClose={() => setOpenErrorDialog(false)}
          error={status.message}
          showRevertNote={false}
        />
      )}
    </>
  );
}
