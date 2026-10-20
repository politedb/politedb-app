import { describe, expect, it } from "vitest";
import type { LicenseState } from "src/lib/tauri";
import { trialNote } from "./TrialStatusNote";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 12);

function state(extra: Partial<LicenseState> = {}) {
  return { status: "inactive", ...extra } as LicenseState;
}

const trial = (expires_at: number) => ({
  started_at: expires_at - 14 * DAY,
  expires_at,
  synced_at: NOW,
});

describe("trialNote", () => {
  it("asks to go online when no server trial is known yet", () => {
    expect(trialNote(state(), "pending", NOW, true)?.text).toMatch(
      /not activated yet/
    );
  });

  it("counts the days left of a running trial", () => {
    const note = trialNote(
      state({ trial: trial(NOW + 3 * DAY) }),
      "verified",
      NOW,
      true
    );
    expect(note?.tone).toBe("info");
    expect(note?.text).toMatch(/3 days left/);
    expect(note?.syncText).toBeNull();
  });

  it("reports an ended trial, also when the server cannot be reached", () => {
    const note = trialNote(
      state({ trial: trial(NOW - DAY) }),
      "unavailable",
      NOW,
      true
    );
    expect(note?.tone).toBe("warning");
    expect(note?.text).toMatch(/Free trial ended on/);
    expect(note?.syncText).toMatch(/Couldn't reach the license server/);
  });

  it("ignores trial dates an older build kept on the device", () => {
    const note = trialNote(
      state({ trial_expires_at: NOW + 5 * DAY, trial: null }),
      "pending",
      NOW,
      true
    );
    expect(note?.text).toMatch(/not activated yet/);
  });

  it("keeps showing the trial for an active license that is not paid", () => {
    const free = { status: "active", paid_license: false };
    expect(
      trialNote(
        state({ ...free, trial: trial(NOW + DAY) }),
        "verified",
        NOW,
        true
      )?.text
    ).toMatch(/1 day left/);
    expect(
      trialNote(
        state({ ...free, trial: trial(NOW - DAY) }),
        "verified",
        NOW,
        true
      )?.text
    ).toMatch(/ended/);
    const offline = trialNote(state(free), "unavailable", NOW, true);
    expect(offline?.text).toMatch(/not activated yet/);
    expect(offline?.syncText).toMatch(/Couldn't reach/);
  });

  it("says nothing for a paid license or a flavor without trials", () => {
    expect(
      trialNote(
        state({
          status: "active",
          paid_license: true,
          trial: trial(NOW + DAY),
        }),
        "unavailable",
        NOW,
        true
      )
    ).toBeNull();
    expect(trialNote(state(), "pending", NOW, false)).toBeNull();
  });
});
