import { describe, expect, it } from "vitest";
import { accountPlanLabel, knownPlanLabel } from "./planLabel";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const trial = (endsInDays: number) => ({
  started_at: NOW - 14 * DAY + endsInDays * DAY,
  expires_at: NOW + endsInDays * DAY,
  synced_at: NOW,
});

describe("accountPlanLabel", () => {
  it("shows Pro trial while a server trial runs", () => {
    expect(accountPlanLabel({ trial: trial(5) }, NOW, true)).toBe("Pro trial");
    expect(
      accountPlanLabel({ plan_name: "Free", trial: trial(1) }, NOW, true)
    ).toBe("Pro trial");
  });

  it("shows the plan once the trial has ended or there is none", () => {
    expect(accountPlanLabel({ trial: trial(-1) }, NOW, true)).toBe("Free plan");
    expect(accountPlanLabel({ trial: trial(0) }, NOW, true)).toBe("Free plan");
    expect(accountPlanLabel({ trial: null }, NOW, true)).toBe("Free plan");
    expect(accountPlanLabel(null, NOW, true)).toBe("Free plan");
  });

  it("shows the paid plan even while a trial would still run", () => {
    expect(
      accountPlanLabel(
        { plan_name: "Pro", paid_license: true, trial: trial(5) },
        NOW,
        true
      )
    ).toBe("Pro plan");
  });

  it("never shows a trial on flavors without trials", () => {
    expect(accountPlanLabel({ trial: trial(5) }, NOW, false)).toBe("Free plan");
  });

  it("uses the tier when the plan has no display name", () => {
    expect(
      accountPlanLabel(
        { plan_name: null, plan: "pro", paid_license: true, trial: null },
        0,
        true
      )
    ).toBe("Pro plan");
  });
});

describe("knownPlanLabel", () => {
  it("is null when the license names no plan", () => {
    expect(
      knownPlanLabel(
        { plan_name: null, plan: null, paid_license: true, trial: null },
        0,
        true
      )
    ).toBeNull();
    expect(
      knownPlanLabel(
        { plan_name: "Pro", plan: null, paid_license: true, trial: null },
        0,
        true
      )
    ).toBe("Pro plan");
  });
});
