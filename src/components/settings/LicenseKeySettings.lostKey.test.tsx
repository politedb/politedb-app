import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));

// zustand's React hook needs the React adapter; the screen only reads the store.
vi.mock("src/stores/license", () => ({
  useLicenseStore: () => ({
    state: { status: "inactive" } as LicenseState,
    loaded: true,
    busy: false,
    error: null,
    load: vi.fn(),
    activate: vi.fn(),
    refresh: vi.fn(),
    deactivate: vi.fn(),
    clearError: vi.fn(),
    trialSync: { status: "verified", lastOkAt: null },
  }),
}));
vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  openExternalUrl: (...a: unknown[]) => mocks.openUrl(...a),
}));

import { LicenseKeySettings } from "./LicenseKeySettings";

afterEach(() => cleanup());

describe("LicenseKeySettings lost key", () => {
  it("opens the Polar customer portal", () => {
    render(<LicenseKeySettings active />);
    fireEvent.click(screen.getByRole("button", { name: "Lost license key?" }));
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://polar.sh/politedb/portal"
    );
  });
});
