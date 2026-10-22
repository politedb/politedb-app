import { useEffect, useState } from "preact/hooks";
import {
  getTelemetryConsent,
  setTelemetryConsent,
  type TelemetryConsent,
} from "src/lib/analytics";
import { SettingCard } from "src/components/settings/SettingCard";
import { CheckMarkIcon, XIcon } from "src/components/icons";
import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import { openExternalUrl } from "src/lib/tauri";

export const PRIVACY_POLICY_URL = "https://politedb.com/privacy";

export function AnalyticsSettings(props: { active: boolean }) {
  const [telemetryConsent, setTelemetryConsentState] =
    useState<TelemetryConsent>(() => getTelemetryConsent());

  useEffect(() => {
    if (props.active) {
      setTelemetryConsentState(getTelemetryConsent());
    }
  }, [props.active]);

  function saveTelemetryConsent(next: Exclude<TelemetryConsent, "unknown">) {
    setTelemetryConsent(next);
    setTelemetryConsentState(next);
  }

  const analyticsEnabled = telemetryConsent === "granted";

  return (
    <>
      <SettingCard class="rounded-xl p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-slate-900">
              Allow detailed product analytics
            </div>
            <div class="mt-1 text-sm text-slate-600">
              Enables extra usage metrics such as connection and query actions.
              You can disable it at any time.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={analyticsEnabled}
            onClick={() =>
              saveTelemetryConsent(analyticsEnabled ? "denied" : "granted")
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
      </SettingCard>

      {/* Plain text, not cards: there is nothing to change here. */}
      <div class="space-y-3 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
        <div class="flex gap-2">
          <CheckMarkIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          <div>
            <div class="font-medium text-slate-800">Always sent</div>
            <div>
              App opens, installs, daily active usage and update events, with a
              random install ID — never your email or license key. These cannot
              be turned off.
            </div>
          </div>
        </div>
        <div class="flex gap-2">
          <XIcon className="mt-0.5 size-4 shrink-0 text-rose-600" />
          <div>
            <div class="font-medium text-slate-800">Not included in events</div>
            <div>
              Your SQL queries or their results, error messages, host and
              database names, passwords, your email or license key. When
              something fails, only a short category such as "timeout" or
              "auth_failed" is sent.
            </div>
          </div>
        </div>
      </div>

      {DISTRIBUTION_FEATURES.websiteLinks ? (
        <button
          type="button"
          class="text-sm text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
          onClick={() => void openExternalUrl(PRIVACY_POLICY_URL)}
        >
          Privacy policy ↗
        </button>
      ) : null}
    </>
  );
}
