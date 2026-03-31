import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import {
  getTelemetryConsent,
  setTelemetryConsent,
  type TelemetryConsent,
} from "src/lib/analytics";

export function PrivacyDialog(props: {
  open: boolean;
  onClose: () => void;
  forceChoice?: boolean;
  onConsentSaved?: (consent: Exclude<TelemetryConsent, "unknown">) => void;
}) {
  const { open, onClose, forceChoice = false, onConsentSaved } = props;
  const consent = getTelemetryConsent();
  const analyticsEnabled = consent === "granted";

  function saveConsent(next: Exclude<TelemetryConsent, "unknown">) {
    setTelemetryConsent(next);
    onConsentSaved?.(next);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={forceChoice ? undefined : onClose}
      size="sm"
      showCloseButton={!forceChoice}
      closeOnEsc={!forceChoice}
      closeOnOutsideClick={!forceChoice}
    >
      <DialogHeader>
        <DialogTitle>Privacy & Analytics Setting</DialogTitle>
        <DialogDescription>
          App open and update telemetry are always tracked with privacy-safe
          metadata. Detailed product analytics only run if you allow them.
        </DialogDescription>
      </DialogHeader>

      <DialogContent className="gap-3 pt-0 pb-6">
        <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <div class="font-medium text-slate-900">What we do not send</div>
          <div class="mt-1">
            No raw SQL text, no query content, no file paths, and no sensitive
            database names.
          </div>
        </div>

        <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <div class="font-medium text-slate-900">Always tracked</div>
          <div class="mt-1">
            App opens, installs, daily active usage, and app update events.
          </div>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium text-slate-900">
                Allow detailed product analytics
              </div>
              <div class="mt-1 text-sm text-slate-600">
                This enables extra usage metrics such as connection and query
                actions. You can disable it at any time.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={analyticsEnabled}
              onClick={() =>
                saveConsent(analyticsEnabled ? "denied" : "granted")
              }
              class={[
                "relative inline-flex h-7 w-13 shrink-0 items-center rounded-full border transition-colors focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none",
                analyticsEnabled
                  ? "border-blue-600 bg-blue-600"
                  : "border-slate-300 bg-slate-200",
              ].join(" ")}
              title={
                analyticsEnabled
                  ? "Turn off detailed analytics"
                  : "Turn on detailed analytics"
              }
            >
              <span
                class={[
                  "inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
                  analyticsEnabled ? "translate-x-7" : "translate-x-1",
                ].join(" ")}
              />
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
