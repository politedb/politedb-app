import type { LicenseState } from "src/lib/tauri/license";
import {
  DISTRIBUTION_FEATURES,
  type DistributionFeatures,
} from "src/lib/distribution";

/** Features that need a Pro license or a running trial. */
export type ProFeature =
  | "backup-restore"
  | "query-analyzer"
  | "health-inspector"
  | "er-diagram-export"
  | "export-masking"
  | "ai-agent";

export const PRO_FEATURE_LABELS: Record<ProFeature, string> = {
  "backup-restore": "Database backup and restore",
  "query-analyzer": "Visual query analyzer",
  "health-inspector": "Database health inspector",
  "er-diagram-export": "ER diagram export to SVG",
  "export-masking": "Column masking on export",
  "ai-agent": "AI agent mode",
};

/** Order of the features in the upgrade dialog. */
export const PRO_FEATURES: ProFeature[] = [
  "ai-agent",
  "backup-restore",
  "query-analyzer",
  "health-inspector",
  "er-diagram-export",
  "export-masking",
];

export const PRICING_URL = "https://politedb.com/pricing";

/** Error code thrown when a Pro-only path runs without Pro access. */
export const PRO_REQUIRED = "PRO_REQUIRED";

/**
 * Whether Pro features are unlocked at `now`. `pro_access` and `pro_access_until` come from
 * the Rust side (paid license or running trial); access also ends locally once
 * `pro_access_until` passes. Flavors that do not gate Pro features are always unlocked.
 */
export function hasProAccess(
  state:
    | Pick<LicenseState, "pro_access" | "pro_access_until">
    | null
    | undefined,
  features: Pick<
    DistributionFeatures,
    "gatesProFeatures"
  > = DISTRIBUTION_FEATURES,
  now: number = Date.now()
): boolean {
  if (!features.gatesProFeatures) return true;
  if (state?.pro_access !== true) return false;
  const until = state.pro_access_until;
  return until == null || now < until;
}

export function proRequiredError(feature: ProFeature) {
  return new Error(
    `${PRO_REQUIRED}: ${PRO_FEATURE_LABELS[feature]} needs PoliteDB Pro.`
  );
}

export function isProRequiredError(error: unknown) {
  return String(error).includes(PRO_REQUIRED);
}
