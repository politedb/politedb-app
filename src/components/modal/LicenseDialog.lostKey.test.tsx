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

import { LicenseDialog } from "./LicenseDialog";

const lostKey = () => screen.getByRole("button", { name: "Lost license key?" });

beforeEach(() => {
  mocks.openUrl.mockReset();
});

afterEach(() => cleanup());

describe("LicenseDialog lost key", () => {
  it("opens the Polar customer portal on Direct builds and stays on the key form", () => {
    mocks.features.externalPurchase = true;
    render(<LicenseDialog open onClose={() => {}} />);
    fireEvent.click(lostKey());
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://polar.sh/politedb/portal"
    );
    expect(screen.getByText("License Key")).toBeInTheDocument();
    expect(screen.queryByText("Recover license key")).toBeNull();
  });

  it("shows email recovery on App Store builds, with Back to the key form", () => {
    mocks.features.externalPurchase = false;
    render(<LicenseDialog open onClose={() => {}} />);
    fireEvent.click(lostKey());
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(screen.getByText("Recover license key")).toBeInTheDocument();
    expect(screen.getByText("support@politedb.com")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Lost license key?" })
    ).toBeNull();

    fireEvent.click(screen.getByText("support@politedb.com"));
    const [url, fallback] = mocks.openUrl.mock.calls[0];
    expect(url).toMatch(/^mailto:support@politedb\.com\?subject=/);
    expect(typeof fallback).toBe("function");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("License Key")).toBeInTheDocument();
  });

  it("starts on the key form again after closing and reopening", () => {
    mocks.features.externalPurchase = false;
    const view = render(<LicenseDialog open onClose={() => {}} />);
    fireEvent.click(lostKey());
    expect(screen.getByText("Recover license key")).toBeInTheDocument();
    view.rerender(<LicenseDialog open={false} onClose={() => {}} />);
    view.rerender(<LicenseDialog open onClose={() => {}} />);
    expect(screen.getByText("License Key")).toBeInTheDocument();
  });
});
