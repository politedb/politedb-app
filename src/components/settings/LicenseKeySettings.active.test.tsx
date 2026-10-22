import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";

const store = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

// zustand's React hook needs the React adapter; the screen only reads the store.
vi.mock("src/stores/license", () => ({
  useLicenseStore: () => store.current,
}));
const dialogs = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock("src/lib/system-dialog", () => dialogs);

import { LicenseKeySettings } from "./LicenseKeySettings";

const KEY = "PLD-ABCDEF12-3456-7890-ABCD-1234567890AB";

function show(state: Partial<LicenseState>) {
  store.current = {
    state: { customer_email: "a@b.c", ...state } as LicenseState,
    loaded: true,
    busy: false,
    error: null,
    load: vi.fn(),
    activate: vi.fn(),
    refresh: vi.fn(),
    deactivate: vi.fn(),
    clearError: vi.fn(),
    trialSync: { status: "verified", lastOkAt: null },
  };
  render(<LicenseKeySettings active />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LicenseKeySettings active license", () => {
  it("says which plan is active instead of asking to activate", () => {
    show({
      status: "active",
      paid_license: true,
      plan_name: "pro",
      license_key: KEY,
    });

    expect(
      screen.getByText("Pro plan is active on this device.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Activate a license key/)).toBeNull();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("shows the key shortened, never whole", () => {
    show({
      status: "active",
      paid_license: true,
      plan_name: "pro",
      license_key: KEY,
    });

    expect(screen.getByText("PLD-ABCD…90AB")).toBeInTheDocument();
    expect(screen.queryByText(KEY)).toBeNull();
  });

  it("leaves out the key row when the key is not known", () => {
    show({ status: "active", paid_license: true, plan_name: "pro" });
    expect(screen.queryByText("License key")).toBeNull();
  });

  it("names a paid Pro license from its tier when the plan has no name", () => {
    show({
      status: "active",
      paid_license: true,
      plan: "pro",
      plan_name: null,
    });

    expect(
      screen.getByText("Pro plan is active on this device.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Free plan/)).toBeNull();
  });

  it("does not call an active license Free when no plan is known", () => {
    show({ status: "active", paid_license: true, plan: null, plan_name: null });

    expect(
      screen.getByText("Your license is active on this device.")
    ).toBeInTheDocument();
    // Other rows may also read "Unknown"; check the Plan row itself.
    const planRow = screen.getByText("Plan").closest(".flex");
    expect(planRow?.textContent).toContain("Unknown");
    expect(screen.queryByText(/Free plan/)).toBeNull();
  });

  it("asks before deactivating, and keeps the license on Cancel", async () => {
    show({ status: "active", paid_license: true, plan_name: "pro" });
    const deactivate = store.current.deactivate as ReturnType<typeof vi.fn>;

    dialogs.confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await vi.waitFor(() => expect(dialogs.confirmDialog).toHaveBeenCalled());
    expect(deactivate).not.toHaveBeenCalled();

    dialogs.confirmDialog.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledTimes(1));
    expect(dialogs.confirmDialog).toHaveBeenLastCalledWith(
      expect.stringContaining("Pro features lock on this device"),
      expect.objectContaining({ okLabel: "Deactivate" })
    );
  });

  it("keeps the activation prompt while no license is active", () => {
    show({ status: "inactive" });
    expect(screen.getByText(/Activate a license key/)).toBeInTheDocument();
  });
});
