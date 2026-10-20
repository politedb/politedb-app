import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";

const DIRECT = {
  externalPurchase: true,
  gatesProFeatures: true,
  serverTrial: true,
};
const APP_STORE = {
  externalPurchase: false,
  gatesProFeatures: false,
  serverTrial: false,
};

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  navigate: vi.fn(),
  features: {} as Record<string, boolean>,
  store: null as unknown,
  status: "inactive",
  extra: {} as Partial<LicenseState>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => mocks.invoke(...a),
}));
// The real opener runs; only the webview navigation it falls back to is observed.
vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  navigateToUrl: (...a: unknown[]) => mocks.navigate(...a),
}));
vi.mock("src/lib/distribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/distribution")>()),
  DISTRIBUTION_FEATURES: mocks.features,
}));
// One stable store object, like the real store's (effects depend on its functions).
vi.mock("src/stores/license", () => ({
  useLicenseStore: () =>
    (mocks.store ??= {
      state: {
        status: mocks.status,
        customer_email: "buyer@example.com",
        device_name: "Test Mac",
        ...mocks.extra,
      } as LicenseState,
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

import { LICENSE_RECOVERY_MAILTO } from "src/lib/license/support";
import { LicenseDialog } from "./LicenseDialog";

const lostKey = () => screen.getByRole("button", { name: "Lost license key?" });
const keyInput = () =>
  screen.getByPlaceholderText(
    "PLD-XXXX-XXXX-XXXX-XXXX-XXXX"
  ) as HTMLInputElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(features: Record<string, boolean>) {
  Object.assign(mocks.features, features);
  return render(<LicenseDialog open onClose={() => {}} />);
}

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.navigate.mockReset();
  mocks.store = null;
  mocks.status = "inactive";
  mocks.extra = {};
});

afterEach(() => cleanup());

describe("LicenseDialog lost key", () => {
  it("opens the Polar portal on Direct builds and keeps the typed key", async () => {
    setup(DIRECT);
    fireEvent.input(keyInput(), { target: { value: "PLD-1234" } });
    fireEvent.click(lostKey());
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("license_open_external_url", {
      url: "https://polar.sh/politedb/portal",
    });
    expect(screen.getByText("License Key")).toBeInTheDocument();
    expect(keyInput().value).toBe("PLD-1234");
  });

  it("shows email recovery on App Store builds; Back restores the form and typed key", () => {
    setup(APP_STORE);
    fireEvent.input(keyInput(), { target: { value: "PLD-1234" } });
    fireEvent.click(lostKey());
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByText("Recover license key")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Lost license key?" })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("License Key")).toBeInTheDocument();
    expect(keyInput().value).toBe("PLD-1234");
  });

  it("Back returns an active license to its management view", () => {
    mocks.status = "active";
    setup(APP_STORE);
    expect(screen.getByText("Managed by email:")).toBeInTheDocument();
    fireEvent.click(lostKey());
    expect(screen.getByText("Recover license key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Managed by email:")).toBeInTheDocument();
    expect(screen.getByText("buyer@example.com")).toBeInTheDocument();
  });

  for (const action of ["support@politedb.com", "open in mail app"]) {
    it(`"${action}" falls back to the full mailto link when the opener fails`, async () => {
      setup(APP_STORE);
      fireEvent.click(lostKey());
      mocks.invoke.mockRejectedValue(
        "FAILED_TO_OPEN_URL: exited with status 1"
      );
      fireEvent.click(screen.getByText(action));
      await flush();
      expect(mocks.invoke).toHaveBeenCalledWith("license_open_external_url", {
        url: LICENSE_RECOVERY_MAILTO,
      });
      expect(mocks.navigate).toHaveBeenCalledWith(LICENSE_RECOVERY_MAILTO);
    });
  }

  it("never navigates when the distribution policy blocks the mail link", async () => {
    setup(APP_STORE);
    fireEvent.click(lostKey());
    mocks.invoke.mockRejectedValue("FEATURE_UNAVAILABLE_IN_DISTRIBUTION");
    fireEvent.click(screen.getByText("open in mail app"));
    await flush();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("starts on the key form again after closing and reopening", () => {
    const view = setup(APP_STORE);
    fireEvent.click(lostKey());
    expect(screen.getByText("Recover license key")).toBeInTheDocument();
    view.rerender(<LicenseDialog open={false} onClose={() => {}} />);
    view.rerender(<LicenseDialog open onClose={() => {}} />);
    expect(screen.getByText("License Key")).toBeInTheDocument();
  });
});

describe("LicenseDialog renewal row", () => {
  it.each([
    ["Direct", DIRECT],
    ["App Store", APP_STORE],
  ])("shows the shared renewal row and fallback on %s", (_name, features) => {
    mocks.status = "active";
    mocks.extra = {
      subscription_status: "canceled",
      ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    setup(features);
    expect(screen.getByText(/Ends on:/)).toBeInTheDocument();
    expect(screen.getByText(/\(in (29|30) days\)/)).toBeInTheDocument();
    cleanup();

    // A known status without a usable date shows status words, not the fallback.
    mocks.store = null;
    mocks.extra = { subscription_status: "paused" };
    setup(features);
    expect(screen.getByText(/Status:/)).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("Renews with your subscription")).toBeNull();
    cleanup();

    mocks.store = null;
    mocks.extra = {};
    setup(features);
    expect(screen.getByText(/Renewal:/)).toBeInTheDocument();
    expect(
      screen.getByText("Renews with your subscription")
    ).toBeInTheDocument();
  });
});
