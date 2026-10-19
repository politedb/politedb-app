import { DISTRIBUTION_FEATURES } from "src/lib/distribution";
import type { LicenseState } from "src/lib/tauri";
import type { TrialSyncStatus } from "src/stores/license";
import { cn } from "src/utils/cn";
import { formatDateTime } from "src/utils/convert";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrialNote = {
  tone: "info" | "warning";
  text: string;
  /** Shown muted below the main line when the license server cannot be reached. */
  syncText: string | null;
};

/**
 * Trial line for license screens, from the server-recorded trial (plan pro-gating V5).
 * `null` when there is nothing to say: an active paid license, or a flavor without trials.
 */
export function trialNote(
  state: LicenseState | null,
  syncStatus: TrialSyncStatus,
  now: number = Date.now(),
  serverTrial: boolean = DISTRIBUTION_FEATURES.serverTrial
): TrialNote | null {
  if (!serverTrial || !state) return null;
  // Only a paid license makes the trial irrelevant; an active free or unknown plan may
  // still get Pro from the trial.
  if (state.paid_license === true) return null;
  const syncText =
    syncStatus === "unavailable" ? "Couldn't reach the license server." : null;
  const trial = state.trial;
  if (!trial) {
    return {
      tone: "info",
      text: "Free trial not activated yet. Connect to the internet to start it.",
      syncText,
    };
  }
  if (now < trial.expires_at) {
    const days = Math.max(1, Math.ceil((trial.expires_at - now) / DAY_MS));
    return {
      tone: "info",
      text: `Free trial: ${days} day${days === 1 ? "" : "s"} left (ends ${formatDateTime(trial.expires_at)}).`,
      syncText,
    };
  }
  return {
    tone: "warning",
    text: `Free trial ended on ${formatDateTime(trial.expires_at)}.`,
    syncText,
  };
}

export function TrialStatusNote(props: {
  note: TrialNote;
  className?: string;
}) {
  const { note } = props;
  return (
    <div
      class={cn(
        "px-3 py-2 text-sm",
        note.tone === "warning"
          ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          : "bg-slate-50 text-slate-700 dark:text-neutral-300",
        props.className
      )}
    >
      <div>{note.text}</div>
      {note.syncText ? (
        <div class="mt-0.5 text-xs text-slate-500 dark:text-neutral-400">
          {note.syncText}
        </div>
      ) : null}
    </div>
  );
}
