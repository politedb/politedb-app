import { navigateToUrl, openExternalUrl } from "src/lib/tauri";

export const LICENSE_SUPPORT_EMAIL = "support@politedb.com";

/** A fixed recovery request: no account data is added to the link. */
export const LICENSE_RECOVERY_MAILTO = `mailto:${LICENSE_SUPPORT_EMAIL}?subject=${encodeURIComponent(
  "PoliteDB license key recovery"
)}&body=${encodeURIComponent(
  "Please help me recover my license key. I purchased using this email address.\n"
)}`;

/**
 * Opens the recovery email in the mail app. If the system opener fails, the webview
 * navigates to the mailto link instead; a distribution policy block opens nothing.
 */
export function openLicenseRecoveryMail() {
  return openExternalUrl(LICENSE_RECOVERY_MAILTO, navigateToUrl);
}
