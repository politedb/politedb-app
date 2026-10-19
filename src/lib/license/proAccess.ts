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
  | "export-masking";

export const PRO_FEATURE_LABELS: Record<ProFeature, string> = {
  "backup-restore": "Database backup and restore",
  "query-analyzer": "Visual query analyzer",
  "health-inspector": "Database health inspector",
  "er-diagram-export": "ER diagram export",
  "export-masking": "Column masking on export",
};

export const PRICING_URL = "https://politedb.com/pricing";

/** Error code thrown when a Pro-only path runs without Pro access. */
export const PRO_REQUIRED = "PRO_REQUIRED";

/**
 * Whether Pro features are unlocked. `pro_access` is computed by the Rust side (active
 * license or running trial); flavors that do not gate Pro features are always unlocked.
 */
export function hasProAccess(
  state: Pick<LicenseState, "pro_access"> | null | undefined,
  features: Pick<
    DistributionFeatures,
    "gatesProFeatures"
  > = DISTRIBUTION_FEATURES
): boolean {
  if (!features.gatesProFeatures) return true;
  return state?.pro_access === true;
}

export function proRequiredError(feature: ProFeature) {
  return new Error(
    `${PRO_REQUIRED}: ${PRO_FEATURE_LABELS[feature]} needs PoliteDB Pro.`
  );
}

export function isProRequiredError(error: unknown) {
  return String(error).includes(PRO_REQUIRED);
}
