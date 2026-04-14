import { useEffect, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { licenseOpenExternalUrl } from "src/lib/tauri";
import { useLicenseStore } from "src/stores/license";
import { ErrorDialog } from "./ErrorDialog";
import { cn } from "src/utils/cn";
import { formatDateTime, formatDaysUntil } from "src/utils/convert";

const PRICING_URL = "https://politedb.com/pricing";
/** Inbox for license recovery; send from the email used at purchase. */
const LICENSE_SUPPORT_EMAIL = "support@politedb.com";

export function LicenseDialog(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const {
    state,
    busy,
    error,
    loaded,
    load,
    activate,
    refresh,
    deactivate,
    clearError,
  } = useLicenseStore();
  const [licenseKey, setLicenseKey] = useState("");
  const [lostKeyHelp, setLostKeyHelp] = useState(false);

  useEffect(() => {
    if (!open) return;
    clearError();
    if (!loaded) {
      void load();
    }
  }, [open, loaded, load, clearError]);

  useEffect(() => {
    if (!open) return;
    setLicenseKey("");
    setLostKeyHelp(false);
  }, [open, state?.license_key]);

  const isActive = (state?.status ?? "").toLowerCase() === "active";
  const trialExpiresAt =
    typeof state?.trial_expires_at === "number" ? state.trial_expires_at : null;
  const isTrialExpired =
    trialExpiresAt != null && trialExpiresAt <= Date.now() && !isActive;
  const daysUntilExpires = formatDaysUntil(state?.expires_at);

  const handleActivate = async () => {
    const next = licenseKey.trim();
    if (!next) return;
    await activate(next);
    setLicenseKey("");
  };

  const handleBuyLicense = async () => {
    try {
      await licenseOpenExternalUrl(PRICING_URL);
    } catch {
      window.open(PRICING_URL, "_blank", "noopener,noreferrer");
    }
  };

  const handleOpenRecoveryMail = async () => {
    const subject = encodeURIComponent("PoliteDB license key recovery");
    const body = encodeURIComponent(
      "Please help me recover my license key. I purchased using this email address.\n"
    );
    const mailto = `mailto:${LICENSE_SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
    try {
      await licenseOpenExternalUrl(mailto);
    } catch {
      window.location.href = mailto;
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} size="md">
        <DialogHeader>
          <DialogTitle>
            {lostKeyHelp ? "Recover license key" : "License Key"}
          </DialogTitle>
          <DialogDescription>
            {lostKeyHelp
              ? "Use the email you used when purchasing to contact support."
              : "Activate a license key for this device and manage its status."}
          </DialogDescription>
        </DialogHeader>

        <DialogContent className="gap-3 pt-0">
          {lostKeyHelp ? (
            <div class="space-y-3 text-sm text-slate-700">
              <ol class="list-decimal space-y-2 pl-5">
                <li>
                  Send an email{" "}
                  <strong class="text-slate-900">from the same address</strong>{" "}
                  you used when you bought PoliteDB (your registered purchase
                  email).
                </li>
                <li>
                  Address it to{" "}
                  <button
                    type="button"
                    class="inline rounded font-mono text-sm text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
                    onClick={() => void handleOpenRecoveryMail()}
                  >
                    {LICENSE_SUPPORT_EMAIL}
                  </button>
                  . Ask to recover your license key.
                </li>
                <li>
                  We will verify your purchase and reply with your license key.
                </li>
              </ol>
              <p class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600">
                Tip: use{" "}
                <button
                  type="button"
                  class="font-medium text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
                  onClick={() => void handleOpenRecoveryMail()}
                >
                  open in mail app
                </button>{" "}
                to start a draft to the correct address.
              </p>
            </div>
          ) : !isActive ? (
            <div class="space-y-2">
              <div class="text-sm font-medium text-slate-900">
                Activate license key
              </div>
              <input
                type="text"
                value={licenseKey}
                onInput={(e) =>
                  setLicenseKey((e.currentTarget as HTMLInputElement).value)
                }
                placeholder="PLD-XXXX-XXXX-XXXX-XXXX-XXXX"
                class="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <div class="text-sm text-neutral-400">
                If you have purchased a license key, please check your email to
                see the license key.
              </div>
              {trialExpiresAt ? (
                <div
                  class={cn(
                    "rounded-xl border px-3 py-2 text-sm",
                    isTrialExpired
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-slate-200 bg-slate-50 text-slate-600"
                  )}
                >
                  {isTrialExpired
                    ? `Free trial expired on ${formatDateTime(trialExpiresAt)}.`
                    : `Free trial ends on ${formatDateTime(trialExpiresAt)}.`}
                </div>
              ) : null}
            </div>
          ) : (
            <div class="rounded-xl border border-slate-200 p-3 text-sm">
              <div class="space-y-2 text-neutral-500">
                <div class="space-x-1">
                  <p>Managed by email:</p>
                  <p class="font-medium text-neutral-900">
                    {state?.customer_email || "Unknown"}
                  </p>
                </div>
                <div class="space-x-1">
                  <p>Device name:</p>
                  <p class="font-medium text-neutral-900">
                    {state?.device_name || "Unknown"}
                  </p>
                </div>
                <div class="space-x-1">
                  <p>
                    Expires at:{" "}
                    <span
                      class={cn(
                        "font-medium",
                        daysUntilExpires > 0 ? "text-green-600" : "text-red-600"
                      )}
                    >
                      ({daysUntilExpires > 0 ? "in" : "expired from"}{" "}
                      {daysUntilExpires} days)
                    </span>
                  </p>
                  <p class="font-medium text-neutral-900">
                    {formatDateTime(state?.expires_at, true) || "Unknown"}
                  </p>
                </div>
                <div class="space-x-1">
                  <p>Last checked at:</p>
                  <p class="font-medium text-neutral-900">
                    {formatDateTime(state?.last_validated_at, true) ||
                      "Unknown"}
                  </p>
                </div>
              </div>
            </div>
          )}
        </DialogContent>

        <DialogFooter className="justify-between pt-1">
          {!lostKeyHelp && (
            <Button variant="shadow" onClick={() => setLostKeyHelp(true)}>
              Lost license key?
            </Button>
          )}

          <div class="flex items-center gap-2">
            {lostKeyHelp ? (
              <Button variant="shadow" onClick={() => setLostKeyHelp(false)}>
                Back
              </Button>
            ) : isActive ? (
              <>
                <Button
                  variant="shadow"
                  onClick={() => void refresh()}
                  disabled={busy}
                >
                  {busy ? "Refreshing..." : "Refresh"}
                </Button>
                <Button
                  variant="outline"
                  className="border-red-200 text-red-600 hover:bg-red-50"
                  onClick={() => void deactivate()}
                  disabled={busy}
                >
                  Deactivate
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="shadow"
                  onClick={() => void handleBuyLicense()}
                >
                  Buy a license
                </Button>

                <Button onClick={() => void handleActivate()} loading={busy}>
                  Activate
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </Dialog>

      <ErrorDialog
        open={!!error}
        error={error ?? ""}
        onClose={() => clearError()}
      />
    </>
  );
}
