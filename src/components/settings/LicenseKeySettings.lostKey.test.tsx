import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  features: {
    externalPurchase: true,
    gatesProFeatures: true,
    serverTrial: true,
  },
}));

// zustand's React hook needs the React adapter; the screen only reads the store.
// One stable store object, like the real store's (effects depend on its functions).
const store = vi.hoisted(() => ({
  current: null as unknown,
}));
vi.mock("src/stores/license", () => ({
  useLicenseStore: () =>
    (store.current ??= {
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
vi.mock("src/lib/distribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/distribution")>()),
  DISTRIBUTION_FEATURES: mocks.features,
}));

import { LicenseKeySettings } from "./LicenseKeySettings";

const lostKey = () => screen.getByRole("button", { name: "Lost license key?" });

beforeEach(() => {
  mocks.openUrl.mockReset();
});

afterEach(() => cleanup());

describe("LicenseKeySettings lost key", () => {
  it("opens the Polar customer portal on Direct builds", () => {
    mocks.features.externalPurchase = true;
    render(<LicenseKeySettings active />);
    fireEvent.click(lostKey());
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://polar.sh/politedb/portal"
    );
    expect(screen.queryByText("support@politedb.com")).toBeNull();
  });

  it("shows the email support help on App Store builds", () => {
    mocks.features.externalPurchase = false;
    render(<LicenseKeySettings active />);
    fireEvent.click(lostKey());
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(screen.getByText("support@politedb.com")).toBeInTheDocument();
  });

  it("emails support with a static mailto and a navigation fallback", () => {
    mocks.features.externalPurchase = false;
    render(<LicenseKeySettings active />);
    fireEvent.click(lostKey());
    fireEvent.click(screen.getByText("support@politedb.com"));
    const [url, fallback] = mocks.openUrl.mock.calls[0];
    expect(url).toMatch(/^mailto:support@politedb\.com\?subject=/);
    expect(typeof fallback).toBe("function");
  });

  it("resets the help when the screen becomes active again", () => {
    mocks.features.externalPurchase = false;
    const view = render(<LicenseKeySettings active />);
    fireEvent.click(lostKey());
    expect(screen.getByText("support@politedb.com")).toBeInTheDocument();
    view.rerender(<LicenseKeySettings active={false} />);
    view.rerender(<LicenseKeySettings active />);
    expect(screen.queryByText("support@politedb.com")).toBeNull();
  });
});
