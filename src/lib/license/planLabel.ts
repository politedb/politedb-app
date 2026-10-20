import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import {
  formatLicensePlanLabel,
  type LicenseState,
} from "src/lib/tauri/license";

/** Account menu label: "Pro trial" while a server-recorded trial runs, else the plan. */
export function accountPlanLabel(
  state: Pick<LicenseState, "plan_name" | "paid_license" | "trial"> | null,
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
  return formatLicensePlanLabel(state?.plan_name);
}
