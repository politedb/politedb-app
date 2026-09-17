import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { AppStatusBar } from "./AppStatusBar";
import type { ProfileTab } from "src/stores/screen";

const screenState: {
  activeProfileScreen: string;
  profileTabs: ProfileTab[];
} = {
  activeProfileScreen: "main",
  profileTabs: [],
};

vi.mock("src/hooks/useAppUpdater", () => ({
  useAppUpdater: () => ({ appVersion: "1.2.10" }),
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
    expect(screen.getByText("Telemetry: Enabled (Safe)")).toBeInTheDocument();
  });

  it("renders connected engine and query mode", () => {
    screenState.activeProfileScreen = "tab-1";
    screenState.profileTabs = [
      {
        id: "tab-1",
        label: "Local SQLite",
        engine: "sqlite",
        profileId: "profile-1",
        runtimeConnectionId: "conn-1",
        querySafetyMode: "default",
      },
    ];

    render(<AppStatusBar />);

    expect(screen.getByText("Connected: SQLite")).toBeInTheDocument();
    expect(screen.getByText("Query mode: Default")).toBeInTheDocument();
    expect(
      screen.getByText("Tips: Right-click a table for actions.")
    ).toBeInTheDocument();
  });
});
