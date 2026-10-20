import { afterEach, describe, expect, it } from "vitest";
import { formatDateTime } from "src/utils/convert";
import { renewalPresentation, SUBSCRIPTION_FALLBACK } from "./renewal";

const DAY = 24 * 60 * 60 * 1000;
// Midday local time, so whole-day offsets never cross a calendar boundary by accident.
const NOW = new Date(2026, 9, 20, 12, 0, 0).getTime();
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

describe("renewalPresentation", () => {
  it.each([
    ["active", { renews_at: at(10) }, "Renews on", "in 10 days", "positive"],
    ["active", { renews_at: at(1) }, "Renews on", "in 1 day", "positive"],
    ["trialing", { renews_at: at(5) }, "First payment", "in 5 days", "neutral"],
    ["canceled", { ends_at: at(30) }, "Ends on", "in 30 days", "warning"],
    ["pausing", { ends_at: at(3) }, "Pauses on", "in 3 days", "warning"],
  ] as const)("shows %s with a date", (status, dates, label, detail, tone) => {
    const row = renewalPresentation(
      { subscription_status: status, ...dates },
      NOW
    );
    expect(row).toMatchObject({ label, detail, tone });
    expect(row.value).not.toBe("");
  });

  it("says today for a renewal later today", () => {
    const later = new Date(NOW + 3 * 60 * 60 * 1000).toISOString();
    expect(
      renewalPresentation(
        { subscription_status: "active", renews_at: later },
        NOW
      ).detail
    ).toBe("today");
  });

  it.each([
    ["active", "Renews automatically"],
    ["trialing", "Trial"],
    ["canceled", "Canceled"],
    ["pausing", "Pausing"],
  ] as const)(
    "shows status words for %s without a usable future date",
    (status, value) => {
      for (const date of [
        null,
        undefined,
        "soon",
        at(-1),
        new Date(NOW).toISOString(),
      ]) {
        const row = renewalPresentation(
          { subscription_status: status, renews_at: date, ends_at: date },
          NOW
        );
        expect(row, String(date)).toMatchObject({ label: "Status", value });
        expect(row.detail).toBeUndefined();
      }
    }
  );

  it.each([
    ["paused", "Status", "Paused"],
    ["incomplete", "Status", "Payment pending"],
    ["past_due", "Payment", "Past due. Update your payment method"],
  ] as const)("shows %s as a status", (status, label, value) => {
    expect(
      renewalPresentation(
        { subscription_status: status, renews_at: at(5) },
        NOW
      )
    ).toMatchObject({ label, value });
  });

  it("shows when an ended subscription ended, or just that it ended", () => {
    expect(
      renewalPresentation(
        { subscription_status: "ended", ends_at: at(-3) },
        NOW
      )
    ).toMatchObject({ label: "Ended on", tone: "negative" });
    expect(
      renewalPresentation(
        { subscription_status: "ended", ends_at: "soon" },
        NOW
      )
    ).toMatchObject({ label: "Status", value: "Ended" });
  });

  it("falls back only when nothing is known", () => {
    for (const state of [
      null,
      {},
      { subscription_status: null },
      { subscription_status: "something_new" as never, renews_at: at(5) },
    ]) {
      expect(renewalPresentation(state, NOW)).toEqual({
        label: "Renewal",
        value: SUBSCRIPTION_FALLBACK,
        tone: "neutral",
      });
    }
  });

  describe("a key with its own expiry", () => {
    it("wins over subscription info", () => {
      expect(
        renewalPresentation(
          {
            expires_at: at(10),
            subscription_status: "canceled",
            ends_at: at(2),
          },
          NOW
        )
      ).toMatchObject({
        label: "Expires at",
        detail: "in 10 days",
        tone: "positive",
      });
    });

    it.each([
      [-2, "expired 2 days ago"],
      [-1, "expired 1 day ago"],
    ])("flags an expiry %i days away as %s", (days, detail) => {
      expect(renewalPresentation({ expires_at: at(days) }, NOW)).toMatchObject({
        label: "Expires at",
        detail,
        tone: "negative",
      });
    });

    it("says expired today for an expiry earlier today", () => {
      const earlier = new Date(NOW - 60 * 60 * 1000).toISOString();
      expect(renewalPresentation({ expires_at: earlier }, NOW).detail).toBe(
        "expired today"
      );
    });

    it.each(["soon", "", "   "])(
      "shows Unknown for an unreadable expiry %j, even with subscription info",
      (expiresAt) => {
        const unknown = {
          label: "Expires at",
          value: "Unknown",
          tone: "neutral",
        };
        expect(renewalPresentation({ expires_at: expiresAt }, NOW)).toEqual(
          unknown
        );
        expect(
          renewalPresentation(
            {
              expires_at: expiresAt,
              subscription_status: "active",
              renews_at: at(10),
            },
            NOW
          )
        ).toEqual(unknown);
      }
    );
  });
});

describe("calendar-day wording across time zones", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    // Assigning undefined would store the string "undefined"; remove it instead.
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  // `now` and the renewal are wall-clock instants in the given zone; `days` and the
  // shown date follow that zone's calendar, not UTC.
  it.each([
    // Late evening locally, renewal just after local midnight: a different local day
    // while the UTC date is the same.
    [
      "Asia/Ho_Chi_Minh",
      "2026-10-20T23:30:00+07:00",
      "2026-10-21T00:30:00+07:00",
      "in 1 day",
      [2026, 9, 21],
    ],
    // Just after midnight UTC but still the previous local day.
    [
      "America/Los_Angeles",
      "2026-10-20T16:30:00-07:00",
      "2026-10-20T23:00:00-07:00",
      "today",
      [2026, 9, 20],
    ],
    // Spring forward: a 23-hour local day in between.
    [
      "America/New_York",
      "2027-03-13T12:00:00-05:00",
      "2027-03-15T09:00:00-04:00",
      "in 2 days",
      [2027, 2, 15],
    ],
    // Fall back: a 25-hour local day in between.
    [
      "America/New_York",
      "2026-10-31T12:00:00-04:00",
      "2026-11-02T09:00:00-05:00",
      "in 2 days",
      [2026, 10, 2],
    ],
    // Non-hour offset.
    [
      "Asia/Kolkata",
      "2026-10-20T23:45:00+05:30",
      "2026-10-22T00:15:00+05:30",
      "in 2 days",
      [2026, 9, 22],
    ],
  ] as const)("%s: %s → %s is %s", (tz, now, renewsAt, detail, [y, m, d]) => {
    process.env.TZ = tz;
    const row = renewalPresentation(
      { subscription_status: "active", renews_at: renewsAt },
      Date.parse(now)
    );
    expect(row.detail).toBe(detail);
    expect(row.value).toBe(formatDateTime(new Date(y, m, d, 12).getTime()));
  });
});
