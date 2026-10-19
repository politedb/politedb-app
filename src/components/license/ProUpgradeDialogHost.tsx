import { useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { LicenseDialog } from "src/components/modal/LicenseDialog";
import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import { PRICING_URL, PRO_FEATURE_LABELS } from "src/lib/license/proAccess";
import { openExternalUrl } from "src/lib/tauri";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import { ProBadge } from "./ProBadge";

const PRO_HIGHLIGHTS = [
  "Database backup and restore",
  "Visual query analyzer",
  "Database health inspector",
  "ER diagram export",
  "Column masking on export",
];

/** Single upgrade prompt for every Pro gate; mounted once in the main layout. */
export function ProUpgradeDialogHost() {
  const feature = useProUpgradeStore((store) => store.feature);
  const close = useProUpgradeStore((store) => store.close);
  const [licenseOpen, setLicenseOpen] = useState(false);

  const handleEnterKey = () => {
    close();
    setLicenseOpen(true);
  };

  return (
    <>
      <Dialog open={feature !== null} onClose={close} size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {feature ? PRO_FEATURE_LABELS[feature] : "PoliteDB Pro"}
            <ProBadge />
          </DialogTitle>
          <DialogDescription>
            This feature is part of PoliteDB Pro. Everything else stays free.
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="pt-0">
          <ul class="list-disc space-y-1 pl-5 text-sm text-neutral-700">
            {PRO_HIGHLIGHTS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </DialogContent>
        <DialogFooter className="justify-end gap-2">
          <Button variant="shadow" onClick={handleEnterKey}>
            Enter license key
          </Button>
          {DISTRIBUTION_FEATURES.externalPurchase && (
            <Button onClick={() => void openExternalUrl(PRICING_URL)}>
              See Pro pricing
            </Button>
          )}
        </DialogFooter>
      </Dialog>
      <LicenseDialog open={licenseOpen} onClose={() => setLicenseOpen(false)} />
    </>
  );
}
