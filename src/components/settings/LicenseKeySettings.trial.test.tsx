import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";
import type { TrialSyncStatus } from "src/stores/license";

const store = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

// zustand's React hook needs the React adapter; the screen only reads the store.
vi.mock("src/stores/license", () => ({
  useLicenseStore: () => store.current,
}));

import { LicenseKeySettings } from "./LicenseKeySettings";

const DAY = 24 * 60 * 60 * 1000;

function show(
  state: Partial<LicenseState>,
  status: TrialSyncStatus = "verified"
) {
  store.current = {
    state: {
      status: "active",
      customer_email: "a@b.c",
      ...state,
    } as LicenseState,
    loaded: true,
    busy: false,
    error: null,
    load: vi.fn(),
    activate: vi.fn(),
    refresh: vi.fn(),
    deactivate: vi.fn(),
    clearError: vi.fn(),
    trialSync: { status, lastOkAt: null },
  };
  render(<LicenseKeySettings active />);
}

afterEach(() => cleanup());

describe("LicenseKeySettings trial line", () => {
  it("shows the trial for an active license that is not paid", () => {
    const now = Date.now();
    show({
      paid_license: false,
      trial: {
        started_at: now - DAY,
        expires_at: now + 3 * DAY,
        synced_at: now,
      },
    });
    expect(screen.getByText(/Free trial: 3 days left/)).toBeInTheDocument();
  });

  it("shows offline feedback when no trial is known", () => {
    show({ paid_license: false }, "unavailable");
    expect(screen.getByText(/not activated yet/)).toBeInTheDocument();
    expect(
      screen.getByText(/Couldn't reach the license server/)
    ).toBeInTheDocument();
  });

  it("hides the trial for a paid license", () => {
    const now = Date.now();
    show({
      paid_license: true,
      trial: {
        started_at: now - DAY,
        expires_at: now + 3 * DAY,
        synced_at: now,
      },
    });
    expect(screen.queryByText(/Free trial/)).toBeNull();
  });
});
