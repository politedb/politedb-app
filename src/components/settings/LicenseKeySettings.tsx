import { useEffect, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { licenseOpenExternalUrl } from "src/lib/tauri";
import { useLicenseStore } from "src/stores/license";
import { cn } from "src/utils/cn";
import { formatDateTime, formatDaysUntil } from "src/utils/convert";
import { FieldRow } from "src/components/settings/FieldRow";
import { SettingCard } from "src/components/settings/SettingCard";

const PRICING_URL = "https://politedb.com/pricing";
const LICENSE_SUPPORT_EMAIL = "support@politedb.com";

export function LicenseKeySettings(props: { active: boolean }) {
  const [licenseKey, setLicenseKey] = useState("");
  const [lostKeyHelp, setLostKeyHelp] = useState(false);
  const {
    state: licenseState,
    busy: licenseBusy,
    error: licenseError,
    loaded: licenseLoaded,
    load: loadLicense,
    activate: activateLicense,
    refresh: refreshLicense,
    deactivate: deactivateLicense,
    clearError: clearLicenseError,
  } = useLicenseStore();

  useEffect(() => {
    if (!props.active) return;
    setLicenseKey("");
    setLostKeyHelp(false);
    clearLicenseError();
    if (!licenseLoaded) {
      void loadLicense();
    }
  }, [clearLicenseError, licenseLoaded, loadLicense, props.active]);

  async function openExternalUrl(url: string) {
    try {
      await licenseOpenExternalUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  async function handleActivateLicense() {
    const next = licenseKey.trim();
    if (!next) return;
    await activateLicense(next);
    setLicenseKey("");
  }

  async function openRecoveryMail() {
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
  }

  const isActive = (licenseState?.status ?? "").toLowerCase() === "active";
  const trialExpiresAt =
    typeof licenseState?.trial_expires_at === "number"
      ? licenseState.trial_expires_at
      : null;
  const isTrialExpired =
    trialExpiresAt != null && trialExpiresAt <= Date.now() && !isActive;
  const daysUntilExpires = formatDaysUntil(licenseState?.expires_at);

  return (
    <>
      <div
        class={cn(
          "rounded-xl border px-3 py-2 text-sm",
          lostKeyHelp
            ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-blue-200 bg-blue-50 text-blue-700"
        )}
      >
        {lostKeyHelp
          ? "Use the email you used when purchasing to contact support."
          : "Activate a license key for this device and manage its status."}
      </div>

      {licenseError ? (
        <div class="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {licenseError}
        </div>
      ) : null}

      {!isActive ? (
        <div class="space-y-3">
          <SettingCard>
            <FieldRow
              class="border-b-0"
              label="Activate license key"
              description="Paste license key from purchase email."
            >
              <Input
                className="border border-slate-300"
                type="text"
                value={licenseKey}
                onValueChange={setLicenseKey}
                placeholder="PLD-XXXX-XXXX-XXXX-XXXX-XXXX"
              />
            </FieldRow>
            {trialExpiresAt ? (
              <div
                class={cn(
                  "rounded-b-xl px-3 py-2 text-sm",
                  isTrialExpired
                    ? "bg-amber-50 text-amber-700"
                    : "bg-slate-50 text-slate-700"
                )}
              >
                {isTrialExpired
                  ? `Free trial expired on ${formatDateTime(trialExpiresAt)}.`
                  : `Free trial ends on ${formatDateTime(trialExpiresAt)}.`}
              </div>
            ) : null}
          </SettingCard>

          <div class="flex flex-wrap justify-between gap-2">
            <Button variant="shadow" onClick={() => setLostKeyHelp(true)}>
              Lost license key?
            </Button>
            <div class="flex gap-2">
              <Button
                variant="shadow"
                onClick={() => void openExternalUrl(PRICING_URL)}
              >
                Buy a license
              </Button>
              <Button
                onClick={() => void handleActivateLicense()}
                loading={licenseBusy}
              >
                Activate
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div class="space-y-3">
          <SettingCard class="text-sm [&>div>div]:last:pb-4">
            <FieldRow label="Managed by email:">
              <div class="text-neutral-700">
                {licenseState?.customer_email || "Unknown"}
              </div>
            </FieldRow>
            <FieldRow label="Device name:">
              <div class="text-neutral-700">
                {licenseState?.device_name || "Unknown"}
              </div>
            </FieldRow>
            <FieldRow label="Expires at:">
              <div class="space-x-1 text-neutral-700">
                <span class="font-medium">
                  {formatDateTime(licenseState?.expires_at, true) || "Unknown"}
                </span>
                <span
                  class={
                    daysUntilExpires > 0 ? "text-green-600" : "text-red-600"
                  }
                >
                  ({daysUntilExpires > 0 ? "in" : "expired from"}{" "}
                  {daysUntilExpires} days)
                </span>
              </div>
            </FieldRow>
            <FieldRow label="Last checked at:">
              <div class="text-neutral-700">
                {formatDateTime(licenseState?.last_validated_at, true) ||
                  "Unknown"}
              </div>
            </FieldRow>
          </SettingCard>
          <div class="flex justify-end gap-2">
            <Button
              variant="shadow"
              onClick={() => void refreshLicense()}
              disabled={licenseBusy}
            >
              {licenseBusy ? "Refreshing..." : "Refresh"}
            </Button>
            <Button
              variant="outline"
              className="border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300"
              onClick={() => void deactivateLicense()}
              disabled={licenseBusy}
            >
              Deactivate
            </Button>
          </div>
        </div>
      )}

      {lostKeyHelp && (
        <div class="space-y-3 text-sm text-slate-700">
          <SettingCard class="px-4 py-3">
            <ol class="list-decimal space-y-2 pl-5">
              <li>
                Send email{" "}
                <strong class="text-slate-900">
                  from same purchase address
                </strong>
                .
              </li>
              <li>
                Address it to{" "}
                <button
                  type="button"
                  class="inline rounded font-mono text-sm text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
                  onClick={() => void openRecoveryMail()}
                >
                  {LICENSE_SUPPORT_EMAIL}
                </button>
                . Ask to recover license key.
              </li>
              <li>We verify purchase and reply with license key.</li>
            </ol>
          </SettingCard>

          <div class="flex justify-end">
            <Button variant="shadow" onClick={() => void openRecoveryMail()}>
              Open Mail
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
