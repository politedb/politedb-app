import { useEffect, useState } from "preact/hooks";
import {
  getTelemetryConsent,
  setTelemetryConsent,
  type TelemetryConsent,
} from "src/lib/analytics";
import { SettingCard } from "src/components/settings/SettingCard";

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
      <SettingCard class="p-3 text-sm text-slate-700">
        <div class="font-medium text-slate-900">What we do not send</div>
        <div>
          No raw SQL text, no query content, no file paths, and no sensitive
          database names.
        </div>
      </SettingCard>

      <SettingCard class="p-3 text-sm text-slate-700">
        <div class="font-medium text-slate-900">Always tracked</div>
        <div>
          App opens, installs, daily active usage, and app update events.
        </div>
      </SettingCard>

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
    </>
  );
}
