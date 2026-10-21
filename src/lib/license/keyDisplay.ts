/**
 * A license key shortened for display: enough to recognise it, not enough to
 * reuse it from a screenshot. "PLD-ABCDEF12-…-1234567890AB" → "PLD-ABCD…90AB".
 */
export function maskLicenseKey(key: string | null | undefined): string {
  const trimmed = (key ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 12) return `…${trimmed.slice(-4)}`;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}
