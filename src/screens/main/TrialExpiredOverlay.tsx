import { Button } from "src/components/common/Button";
import { licenseOpenExternalUrl } from "src/lib/tauri";
import type { LicenseState } from "src/lib/tauri/license";

const PRICING_URL = "https://politedb.com/pricing";

function formatDate(value?: number | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(date);
}

export function TrialExpiredOverlay(props: {
  state: LicenseState | null;
  onOpenLicense: () => void;
}) {
  const expiryLabel = formatDate(props.state?.trial_expires_at ?? null);

  async function handleBuyLicense() {
    try {
      await licenseOpenExternalUrl(PRICING_URL);
    } catch {
      window.open(PRICING_URL, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div class="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/55 backdrop-blur-sm">
      <div class="mx-4 w-full max-w-2xl rounded-3xl border border-slate-200 bg-white p-8 shadow-2xl">
        <div class="mx-auto max-w-xl text-center">
          <div class="mb-4 inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700">
            Trial expired
          </div>
          <h1 class="text-3xl font-semibold tracking-tight text-slate-900">
            Your 14-day trial has ended
          </h1>
          <p class="mt-3 text-base leading-7 text-slate-600">
            {expiryLabel
              ? `Your free trial expired on ${expiryLabel}.`
              : "Your free trial has expired."}{" "}
            Enter a license key to continue using PoliteDB on this device.
          </p>

          <div class="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              onClick={props.onOpenLicense}
              className="min-w-44 rounded-2xl py-2"
            >
              Enter license key
            </Button>
            <Button
              variant="shadow"
              onClick={() => void handleBuyLicense()}
              className="min-w-44 rounded-2xl py-2"
            >
              Buy a license
            </Button>
          </div>

          <div class="mt-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left text-sm text-slate-600">
            <div class="font-medium text-slate-900">What is blocked now?</div>
            <div class="mt-1">
              All screens and app functionality remain locked until this device
              has a valid active license.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
