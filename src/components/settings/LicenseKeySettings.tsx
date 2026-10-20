import { useEffect, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { openExternalUrl } from "src/lib/tauri";
import { useLicenseStore } from "src/stores/license";
import { cn } from "src/utils/cn";
import { formatDateTime } from "src/utils/convert";
import {
  TrialStatusNote,
  trialNote,
} from "src/components/license/TrialStatusNote";
import { FieldRow } from "src/components/settings/FieldRow";
import { SettingCard } from "src/components/settings/SettingCard";
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
    trialSync: { status: trialSyncStatus },
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

  async function handleActivateLicense() {
    const next = licenseKey.trim();
    if (!next) return;
    await activateLicense(next);
    setLicenseKey("");
  }

  // Direct builds open the Polar customer portal, where buyers find their keys by
  // purchase email; App Store builds cannot open it and show the email help instead.
  async function handleLostKey() {
    if (!DISTRIBUTION_FEATURES.externalPurchase) {
      setLostKeyHelp(true);
      return;
    }
    await openExternalUrl(LICENSE_PORTAL_URL);
  }

  const isActive = (licenseState?.status ?? "").toLowerCase() === "active";
  const trial = trialNote(licenseState ?? null, trialSyncStatus);
  const renewal = renewalPresentation(licenseState ?? null);

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
              description="Paste your license key here."
            >
              <Input
                className="w-88 max-w-full border border-slate-300"
                type="text"
                value={licenseKey}
                onValueChange={setLicenseKey}
                placeholder="PLD-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
              />
            </FieldRow>
            {trial ? (
              <TrialStatusNote note={trial} className="rounded-b-xl" />
            ) : null}
          </SettingCard>

          <div class="flex flex-wrap justify-between gap-2">
            <Button variant="shadow" onClick={() => void handleLostKey()}>
              Lost license key?
            </Button>
            <div class="flex gap-2">
              {DISTRIBUTION_FEATURES.externalPurchase ? (
                <Button
                  variant="shadow"
                  onClick={() => void openExternalUrl(PRICING_URL)}
                >
                  Buy a license
                </Button>
              ) : null}
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
          {trial ? (
            <TrialStatusNote note={trial} className="rounded-xl" />
          ) : null}
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
            <FieldRow label={`${renewal.label}:`}>
              <div class="space-x-1 text-neutral-700">
                <span class="font-medium">{renewal.value}</span>
                {renewal.detail ? (
                  <span class={RENEWAL_TONE_CLASS[renewal.tone]}>
                    ({renewal.detail})
                  </span>
                ) : null}
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
              loading={licenseBusy}
            >
              Refresh
            </Button>
            <Button
              variant="outline"
              className="border-rose-200 text-rose-700 hover:bg-rose-50"
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
                  onClick={() => void openLicenseRecoveryMail()}
                >
                  {LICENSE_SUPPORT_EMAIL}
                </button>
                . Ask to recover license key.
              </li>
              <li>We verify purchase and reply with license key.</li>
            </ol>
          </SettingCard>

          <div class="flex justify-end">
            <Button
              variant="shadow"
              onClick={() => void openLicenseRecoveryMail()}
            >
              Open Mail
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
