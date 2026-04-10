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

const PRICING_URL = "https://politedb.com/pricing";

function formatDateTime(value?: number | string | null) {
  if (!value) return "";
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

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
  }, [open, state?.license_key]);

  const isActive = (state?.status ?? "").toLowerCase() === "active";
  const trialExpiresAt =
    typeof state?.trial_expires_at === "number" ? state.trial_expires_at : null;
  const isTrialExpired =
    trialExpiresAt != null && trialExpiresAt <= Date.now() && !isActive;
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

  return (
    <>
      <Dialog open={open} onClose={onClose} size="md">
        <DialogHeader>
          <DialogTitle>License Key</DialogTitle>
          <DialogDescription>
            Activate a license key for this device and manage its status.
          </DialogDescription>
        </DialogHeader>

        <DialogContent className="gap-3 pt-0">
          {!isActive ? (
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
            <div class="rounded-xl border border-slate-200 bg-white p-3 text-sm">
              <div class="font-medium text-neutral-900">Activation details</div>
              <div class="mt-2 space-y-2 text-neutral-500">
                <div class="space-x-1">
                  <span>Activated at:</span>
                  <span>
                    {formatDateTime(state?.activated_at) || "Unknown"}
                  </span>
                </div>
                <div class="space-x-1">
                  <span>Last checked at:</span>
                  <span>
                    {formatDateTime(state?.last_validated_at) || "Unknown"}
                  </span>
                </div>
                <div class="space-x-1">
                  <span>Seats allowed:</span>
                  <span>{state?.seats_allowed ?? "Unknown"}</span>
                </div>
                <div class="space-x-1">
                  <span>Devices used:</span>
                  <span>{state?.devices_used ?? "Unknown"}</span>
                </div>
              </div>
            </div>
          )}
        </DialogContent>

        <DialogFooter className="justify-between pt-1">
          <Button variant="shadow" onClick={onClose}>
            Lost license key?
          </Button>

          <div class="flex items-center gap-2">
            {isActive ? (
              <>
                <Button
                  variant="shadow"
                  onClick={() => void refresh()}
                  loading={busy}
                >
                  Refresh
                </Button>
                <Button
                  variant="outline"
                  className="border-red-200 text-red-600 hover:bg-red-50"
                  onClick={() => void deactivate()}
                  loading={busy}
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
