import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { OPEN_SAFETY_MODE_PICKER_EVENT } from "src/lib/queries/querySafetyModes";
import { AppStatusBar } from "./AppStatusBar";
import type { ProfileTab } from "src/stores/screen";

const setActiveProfileScreen = vi.hoisted(() => vi.fn());
const screenState: {
  activeProfileScreen: string;
  profileTabs: ProfileTab[];
  setActiveProfileScreen: (id: string) => void;
} = {
  activeProfileScreen: "main",
  profileTabs: [],
  setActiveProfileScreen,
};

const updater = vi.hoisted(() => ({
  appVersion: "1.7.0",
  updateAvailable: false,
  updateVersion: null as string | null,
}));
vi.mock("src/hooks/useAppUpdater", () => ({
  useAppUpdater: () => updater,
}));

vi.mock("src/lib/analytics", () => ({
  getTelemetryConsent: () => "granted",
}));

vi.mock("src/stores/screen", () => ({
  useScreenStore: (selector: (state: typeof screenState) => unknown) =>
    selector(screenState),
}));

describe("AppStatusBar", () => {
  it("renders the explorer status bar", () => {
    screenState.activeProfileScreen = "main";
    screenState.profileTabs = [];

    render(<AppStatusBar />);

    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByText("No active connection")).toBeInTheDocument();
    // Tips live in the sidebar now, not in the status bar.
    expect(screen.queryByText(/^Tips:/)).toBeNull();
  });

  it("renders the connection, and a mode badge that opens the picker", () => {
    screenState.activeProfileScreen = "tab-1";
    screenState.profileTabs = [
      {
        id: "tab-1",
        label: "Local SQLite",
        engine: "sqlite",
        profileId: "profile-1",
        runtimeConnectionId: "conn-1",
        querySafetyMode: "production",
      },
    ];
    const opened = vi.fn();
    window.addEventListener(OPEN_SAFETY_MODE_PICKER_EVENT, opened);

    render(<AppStatusBar />);

    expect(screen.getByText("Connected: SQLite")).toBeInTheDocument();
    expect(screen.getByText("Local SQLite")).toBeInTheDocument();
    const badge = screen.getByRole("button", {
      name: "Query mode: Production. Change",
    });
    expect(badge.textContent).toBe("Production");
    expect(badge.className).toContain("bg-amber-50");
    fireEvent.click(badge);
    expect(opened).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_SAFETY_MODE_PICKER_EVENT, opened);
    // Tips live in the sidebar now, not in the status bar.
    expect(screen.queryByText(/^Tips:/)).toBeNull();
  });

  it("points to an available update", () => {
    screenState.activeProfileScreen = "main";
    screenState.profileTabs = [];
    updater.updateAvailable = true;
    updater.updateVersion = "1.7.1";
    try {
      render(<AppStatusBar />);
      fireEvent.click(
        screen.getByRole("button", { name: "Update available: v1.7.1" })
      );
      expect(setActiveProfileScreen).toHaveBeenCalledWith("main");
    } finally {
      updater.updateAvailable = false;
      updater.updateVersion = null;
    }
  });
});
