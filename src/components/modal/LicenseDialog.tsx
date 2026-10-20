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
import { openExternalUrl } from "src/lib/tauri";
import { useLicenseStore } from "src/stores/license";
import { showMessage } from "src/lib/system-dialog";
import { cn } from "src/utils/cn";
import { formatDateTime } from "src/utils/convert";
import {
  TrialStatusNote,
  trialNote,
} from "src/components/license/TrialStatusNote";
import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import { LICENSE_PORTAL_URL } from "src/lib/license/proAccess";
import {
  RENEWAL_TONE_CLASS,
  renewalPresentation,
} from "src/lib/license/renewal";
import {
  LICENSE_SUPPORT_EMAIL,
  openLicenseRecoveryMail,
} from "src/lib/license/support";

const PRICING_URL = "https://politedb.com/pricing";
/** Inbox for license recovery; send from the email used at purchase. */

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
    trialSync: { status: trialSyncStatus },
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
  const trial = trialNote(state ?? null, trialSyncStatus);
  const renewal = renewalPresentation(state ?? null);

  const handleActivate = async () => {
    const next = licenseKey.trim();
    if (!next) return;
    await activate(next);
    setLicenseKey("");
  };

  const handleBuyLicense = async () => {
    await openExternalUrl(PRICING_URL);
  };

  // Direct builds open the Polar customer portal, where buyers find their keys by
  // purchase email; App Store builds cannot open it and show the email help instead.
  const handleLostKey = async () => {
    if (!DISTRIBUTION_FEATURES.externalPurchase) {
      setLostKeyHelp(true);
      return;
    }
    await openExternalUrl(LICENSE_PORTAL_URL);
  };

  useEffect(() => {
    if (!error) return;
    void showMessage(error, { title: "Error", kind: "error" }).then(() => {
      clearError();
    });
  }, [error, clearError]);

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
                    onClick={() => void openLicenseRecoveryMail()}
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
                  onClick={() => void openLicenseRecoveryMail()}
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
              {trial ? (
                <TrialStatusNote
                  note={trial}
                  className="rounded-xl border border-slate-200"
                />
              ) : null}
            </div>
          ) : (
            <div class="rounded-xl border border-slate-200 p-3 text-sm">
              {trial ? (
                <TrialStatusNote note={trial} className="mb-3 rounded-lg" />
              ) : null}
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
                    {renewal.label}:{" "}
                    {renewal.detail ? (
                      <span
                        class={cn(
                          "font-medium",
                          RENEWAL_TONE_CLASS[renewal.tone]
                        )}
                      >
                        ({renewal.detail})
                      </span>
                    ) : null}
                  </p>
                  <p class="font-medium text-neutral-900">{renewal.value}</p>
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
            <Button variant="shadow" onClick={() => void handleLostKey()}>
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
                {DISTRIBUTION_FEATURES.externalPurchase ? (
                  <Button
                    variant="shadow"
                    onClick={() => void handleBuyLicense()}
                  >
                    Buy a license
                  </Button>
                ) : null}

                <Button onClick={() => void handleActivate()} loading={busy}>
                  Activate
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </Dialog>
    </>
  );
}
