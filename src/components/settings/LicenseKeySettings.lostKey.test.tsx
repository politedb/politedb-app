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
import { LicenseKeySettings } from "./LicenseKeySettings";

const lostKey = () => screen.getByRole("button", { name: "Lost license key?" });
const keyInput = () =>
  screen.getByPlaceholderText(
    "PLD-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
  ) as HTMLInputElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(features: Record<string, boolean>) {
  Object.assign(mocks.features, features);
  render(<LicenseKeySettings active />);
}

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.navigate.mockReset();
  mocks.store = null;
  mocks.status = "inactive";
  mocks.extra = {};
});

afterEach(() => cleanup());

describe("LicenseKeySettings lost key", () => {
  it("opens the Polar portal on Direct builds and keeps the typed key", async () => {
    setup(DIRECT);
    fireEvent.input(keyInput(), { target: { value: "PLD-1234" } });
    fireEvent.click(lostKey());
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("license_open_external_url", {
      url: "https://polar.sh/politedb/portal",
    });
    expect(keyInput().value).toBe("PLD-1234");
    expect(screen.queryByText("support@politedb.com")).toBeNull();
  });

  it("shows the email help on App Store builds without opening a link", () => {
    setup(APP_STORE);
    fireEvent.click(lostKey());
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByText("support@politedb.com")).toBeInTheDocument();
  });

  for (const action of ["support@politedb.com", "Open Mail"]) {
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
    fireEvent.click(screen.getByText("Open Mail"));
    await flush();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("resets the help when the screen becomes active again", () => {
    Object.assign(mocks.features, APP_STORE);
    const view = render(<LicenseKeySettings active />);
    fireEvent.click(lostKey());
    expect(screen.getByText("support@politedb.com")).toBeInTheDocument();
    view.rerender(<LicenseKeySettings active={false} />);
    view.rerender(<LicenseKeySettings active />);
    expect(screen.queryByText("support@politedb.com")).toBeNull();
  });
});

describe("the recovery mail link", () => {
  it("is a fixed request to support with no account data", () => {
    expect(LICENSE_RECOVERY_MAILTO).toBe(
      "mailto:support@politedb.com?subject=PoliteDB%20license%20key%20recovery&body=Please%20help%20me%20recover%20my%20license%20key.%20I%20purchased%20using%20this%20email%20address.%0A"
    );
    expect(LICENSE_RECOVERY_MAILTO).not.toContain("buyer@example.com");
  });
});

describe("LicenseKeySettings renewal row in both flavors", () => {
  const inThirtyDays = () =>
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  it.each([
    ["Direct", DIRECT],
    ["App Store", APP_STORE],
  ])(
    "shows renewal, status words and the fallback on %s",
    (_name, features) => {
      mocks.status = "active";
      mocks.extra = {
        subscription_status: "active",
        renews_at: inThirtyDays(),
      };
      setup(features);
      expect(screen.getByText("Renews on")).toBeInTheDocument();
      cleanup();

      mocks.store = null;
      mocks.extra = { subscription_status: "past_due" };
      setup(features);
      expect(screen.getByText("Payment")).toBeInTheDocument();
      expect(
        screen.getByText("Past due. Update your payment method")
      ).toBeInTheDocument();
      cleanup();

      mocks.store = null;
      mocks.extra = {};
      setup(features);
      expect(screen.getByText("Renewal")).toBeInTheDocument();
      expect(
        screen.getByText("Renews with your subscription")
      ).toBeInTheDocument();
    }
  );
});
