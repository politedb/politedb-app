import { cleanup, render, screen, waitFor } from "@testing-library/preact";
import { act } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProUpgradeStore } from "src/stores/proUpgrade";

const mocks = vi.hoisted(() => ({
  choose: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("src/lib/system-dialog", () => ({
  chooseDialog: (...a: unknown[]) => mocks.choose(...a),
}));
vi.mock("src/lib/tauri", () => ({
  openExternalUrl: (...a: unknown[]) => mocks.openUrl(...a),
}));
vi.mock("src/components/modal/LicenseDialog", () => ({
  LicenseDialog: ({ open }: { open: boolean }) =>
    open ? <div>license dialog</div> : null,
}));

import { ProUpgradeDialogHost } from "./ProUpgradeDialogHost";

beforeEach(() => {
  vi.clearAllMocks();
  useProUpgradeStore.setState({ feature: null });
});

afterEach(() => cleanup());

describe("ProUpgradeDialogHost", () => {
  it("asks natively with one line and no feature list", async () => {
    mocks.choose.mockResolvedValue("cancel");
    render(<ProUpgradeDialogHost />);
    act(() => useProUpgradeStore.getState().open("health-inspector"));
    await waitFor(() => expect(mocks.choose).toHaveBeenCalledTimes(1));
    const [body, options] = mocks.choose.mock.calls[0];
    expect(body).toBe("Database health inspector is a PoliteDB Pro feature.");
    expect(options).toMatchObject({
      title: "Upgrade to Pro",
      primary: "Enter license key",
      secondary: "See Pro pricing",
      cancel: "Cancel",
    });
    expect(useProUpgradeStore.getState().feature).toBeNull();
    expect(screen.queryByText("license dialog")).toBeNull();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("opens the license dialog for Enter license key", async () => {
    mocks.choose.mockResolvedValue("primary");
    render(<ProUpgradeDialogHost />);
    act(() => useProUpgradeStore.getState().open("ai-agent"));
    expect(await screen.findByText("license dialog")).toBeInTheDocument();
  });

  it("opens the pricing page for See Pro pricing", async () => {
    mocks.choose.mockResolvedValue("secondary");
    render(<ProUpgradeDialogHost />);
    act(() => useProUpgradeStore.getState().open("export-masking"));
    await waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledWith("https://politedb.com/pricing")
    );
  });

  it("shows one prompt at a time", async () => {
    let answer: (value: string) => void = () => {};
    mocks.choose.mockImplementation(
      () => new Promise((resolve) => (answer = resolve))
    );
    render(<ProUpgradeDialogHost />);
    act(() => useProUpgradeStore.getState().open("ai-agent"));
    act(() => useProUpgradeStore.getState().open("backup-restore"));
    await waitFor(() => expect(mocks.choose).toHaveBeenCalledTimes(1));
    answer("cancel");
  });
});
