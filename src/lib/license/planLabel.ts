import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import {
  formatLicensePlanLabel,
  type LicenseState,
} from "src/lib/tauri/license";

/** Account menu label: "Pro trial" while a server-recorded trial runs, else the plan. */
export function accountPlanLabel(
  state: Pick<
    LicenseState,
    "plan_name" | "plan" | "paid_license" | "trial"
  > | null,
  now: number = Date.now(),
  serverTrial: boolean = DISTRIBUTION_FEATURES.serverTrial
): string {
  const trial = state?.trial;
  if (
    serverTrial &&
    state?.paid_license !== true &&
    trial &&
    now < trial.expires_at
  ) {
    return "Pro trial";
  }
  // The display name, else the tier: a paid license without a name is not Free.
  return formatLicensePlanLabel(state?.plan_name?.trim() || state?.plan);
}

/**
 * The plan label when the license says which plan it is (a name, a tier or a
 * running trial); null when it does not, so an active license is never shown
 * as Free just because the server sent no plan.
 */
export function knownPlanLabel(
  state: Pick<
    LicenseState,
    "plan_name" | "plan" | "paid_license" | "trial"
  > | null,
  now: number = Date.now(),
  serverTrial: boolean = DISTRIBUTION_FEATURES.serverTrial
): string | null {
  const label = accountPlanLabel(state, now, serverTrial);
  const known =
    label === "Pro trial" ||
    !!state?.plan_name?.trim() ||
    !!state?.plan?.trim();
  return known ? label : null;
}
