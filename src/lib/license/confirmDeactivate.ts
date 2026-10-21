import { confirmDialog } from "src/lib/system-dialog";

/** Asks before removing the license from this device; true to go ahead. */
export function confirmDeactivateLicense(): Promise<boolean> {
  return confirmDialog(
    "Pro features lock on this device until you activate a license again. The key can then be used on another device.",
    {
      title: "Deactivate license on this device?",
      kind: "warning",
      okLabel: "Deactivate",
      cancelLabel: "Cancel",
    }
  );
}
