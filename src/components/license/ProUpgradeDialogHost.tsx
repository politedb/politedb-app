import { useEffect, useRef, useState } from "preact/hooks";
import { LicenseDialog } from "src/components/modal/LicenseDialog";
import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import {
  PRICING_URL,
  PRO_FEATURE_LABELS,
  type ProFeature,
} from "src/lib/license/proAccess";
import { chooseDialog } from "src/lib/system-dialog";
import { openExternalUrl } from "src/lib/tauri";
import { useProUpgradeStore } from "src/stores/proUpgrade";

/**
 * Single upgrade prompt for every Pro gate, shown as a native dialog; mounted once in the
 * main layout. "Enter license key" opens the license dialog; "See Pro pricing" (only where
 * external purchase is allowed) opens the pricing page.
 */
export function ProUpgradeDialogHost() {
  const [licenseOpen, setLicenseOpen] = useState(false);
  const prompting = useRef(false);

  useEffect(() => {
    const prompt = (feature: ProFeature) => {
      // One native prompt at a time; clicks while it is open are ignored.
      if (prompting.current) return;
      prompting.current = true;
      void chooseDialog(
        `${PRO_FEATURE_LABELS[feature]} is a PoliteDB Pro feature.`,
        {
          title: "Upgrade to Pro",
          kind: "info",
          primary: "Enter license key",
          secondary: DISTRIBUTION_FEATURES.externalPurchase
            ? "See Pro pricing"
            : undefined,
          cancel: "Cancel",
        }
      )
        .then((choice) => {
          if (choice === "primary") setLicenseOpen(true);
          if (choice === "secondary") void openExternalUrl(PRICING_URL);
        })
        .finally(() => {
          prompting.current = false;
        });
    };
    // Subscribe directly (no React adapter needed); each request is consumed at once.
    return useProUpgradeStore.subscribe((store) => {
      const feature = store.feature;
      if (!feature) return;
      useProUpgradeStore.getState().close();
      prompt(feature);
    });
  }, []);

  return (
    <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />
  );
}
