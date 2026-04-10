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
          {/* <div class="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-slate-900">
                Current status
              </div>
              <div class="mt-1 text-sm text-slate-600">
                {state?.message?.trim() ||
                  (isActive
                    ? "This device is activated."
                    : "This device is not activated yet.")}
              </div>
            </div>
            <StatusBadge status={String(state?.status ?? "inactive")} />
          </div>
        </div> */}

          {/* <div class="">
          <div class="rounded-xl border border-slate-200 bg-white p-3">
            <div class="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Device
            </div>
            <div class="mt-2 text-sm font-medium text-slate-900">
              {state?.device_name || "This device"}
            </div>
            <div class="mt-1 text-xs text-slate-500">{deviceLabel}</div>
            <div class="mt-2 rounded-lg bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">
              {state?.device_id || "Loading..."}
            </div>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-3">
            <div class="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              License
            </div>
            <div class="mt-2 text-sm font-medium text-slate-900">
              {state?.plan_name || "No active plan"}
            </div>
            <div class="mt-1 text-xs text-slate-500">
              {maskLicenseKey(state?.license_key)}
            </div>
            {state?.customer_email ? (
              <div class="mt-2 text-xs text-slate-500">
                {state.customer_email}
              </div>
            ) : null}
            {state?.expires_at ? (
              <div class="mt-1 text-xs text-slate-500">
                Expires {formatDateTime(state.expires_at)}
              </div>
            ) : null}
          </div>
        </div> */}

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
                placeholder="PLD-XXXX-XXXX-XXXX"
                class="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <div class="text-sm text-neutral-400">
                If you have purchased a license key, please check your email to
                see the license key.
              </div>
            </div>
          ) : (
            <div class="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">
              <div class="font-medium text-slate-900">Activation details</div>
              <div class="mt-2 grid gap-2 md:grid-cols-2">
                <div>
                  Activated: {formatDateTime(state?.activated_at) || "Unknown"}
                </div>
                <div>
                  Last checked:{" "}
                  {formatDateTime(state?.last_validated_at) || "Unknown"}
                </div>
                <div>Seats: {state?.seats_allowed ?? "Unknown"}</div>
                <div>Devices used: {state?.devices_used ?? "Unknown"}</div>
              </div>
            </div>
          )}
        </DialogContent>

        <DialogFooter className="justify-between">
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
