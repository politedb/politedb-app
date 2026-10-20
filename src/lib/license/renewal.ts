import type { LicenseState } from "src/lib/tauri/license";
import { formatDateTime } from "src/utils/convert";

/** Subscription states the license server reports for display. */
export type SubscriptionDisplayStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "pausing"
  | "paused"
  | "incomplete"
  | "ended";

export type RenewalTone = "positive" | "warning" | "negative" | "neutral";

export type RenewalPresentation = {
  label: string;
  value: string;
  /** Relative day count, e.g. "in 12 days", "today", "3 days ago". */
  detail?: string;
  tone: RenewalTone;
};

/** Text colour for the relative day count, matching the license panels. */
export const RENEWAL_TONE_CLASS: Record<RenewalTone, string> = {
  positive: "text-green-600",
  warning: "text-amber-600",
  negative: "text-red-600",
  neutral: "text-neutral-500",
};

/** Shown when nothing is known about the renewal. */
export const SUBSCRIPTION_FALLBACK = "Renews with your subscription";

const DAY_MS = 24 * 60 * 60 * 1000;

function parse(value?: string | null) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function startOfDay(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Whole calendar days from `now` to `ms` in local time (negative when past). */
function calendarDays(ms: number, now: number) {
  return Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);
}

function plural(days: number) {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function relative(ms: number, now: number) {
  const days = calendarDays(ms, now);
  if (days === 0) return "today";
  return days > 0 ? `in ${plural(days)}` : `${plural(-days)} ago`;
}

function expiredDetail(ms: number, now: number) {
  const days = -calendarDays(ms, now);
  return days <= 0 ? "expired today" : `expired ${plural(days)} ago`;
}

function dated(
  label: string,
  ms: number,
  now: number,
  tone: RenewalTone
): RenewalPresentation {
  return {
    label,
    value: formatDateTime(ms),
    detail: relative(ms, now),
    tone,
  };
}

function status(value: string, tone: RenewalTone = "neutral") {
  return { label: "Status", value, tone };
}

/**
 * The expiry/renewal row of the license panel. A real key expiry wins (one-time keys);
 * otherwise the subscription status from the license server decides. A known status
 * whose date is missing or no longer in the future shows status words, and the fallback
 * text appears only when nothing is known. Display only: never affects Pro access.
 */
export function renewalPresentation(
  state: Pick<
    LicenseState,
    "expires_at" | "subscription_status" | "renews_at" | "ends_at"
  > | null,
  now: number = Date.now()
): RenewalPresentation {
  // A present expiry, even blank or unreadable, is the key's own (invalid) expiry: the
  // Rust side keeps it present, and it must never read as a subscription.
  if (state?.expires_at != null) {
    const expires = parse(state.expires_at);
    if (expires === null) {
      return { label: "Expires at", value: "Unknown", tone: "neutral" };
    }
    const expired = expires <= now;
    return {
      label: "Expires at",
      value: formatDateTime(expires, true),
      detail: expired ? expiredDetail(expires, now) : relative(expires, now),
      tone: expired ? "negative" : "positive",
    };
  }

  const renewsAt = parse(state?.renews_at);
  const endsAt = parse(state?.ends_at);
  const future = (ms: number | null) => (ms !== null && ms > now ? ms : null);

  switch (state?.subscription_status) {
    case "active": {
      const at = future(renewsAt);
      return at === null
        ? status("Renews automatically", "positive")
        : dated("Renews on", at, now, "positive");
    }
    case "trialing": {
      const at = future(renewsAt);
      return at === null
        ? status("Trial")
        : dated("First payment", at, now, "neutral");
    }
    case "canceled": {
      const at = future(endsAt);
      return at === null
        ? status("Canceled", "warning")
        : dated("Ends on", at, now, "warning");
    }
    case "pausing": {
      const at = future(endsAt);
      return at === null
        ? status("Pausing", "warning")
        : dated("Pauses on", at, now, "warning");
    }
    case "paused":
      return status("Paused", "warning");
    case "incomplete":
      return status("Payment pending", "warning");
    case "past_due":
      return {
        label: "Payment",
        value: "Past due. Update your payment method",
        tone: "negative",
      };
    case "ended":
      return endsAt === null
        ? status("Ended", "negative")
        : {
            label: "Ended on",
            value: formatDateTime(endsAt),
            tone: "negative",
          };
    default:
      return {
        label: "Renewal",
        value: SUBSCRIPTION_FALLBACK,
        tone: "neutral",
      };
  }
}
