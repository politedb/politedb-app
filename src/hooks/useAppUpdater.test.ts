import { h } from "preact";
import { fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppUpdater } from "./useAppUpdater";
import type { RuntimeUpdate } from "src/lib/updater/runtimeUpdater";

const checkForRuntimeUpdate = vi.fn<() => Promise<RuntimeUpdate | null>>(
  async () => null
);
const installRuntimeUpdate = vi.fn();
const isTauriRuntime = vi.fn(() => false);

vi.mock("src/lib/updater/runtimeUpdater", () => ({
  checkForRuntimeUpdate: () => checkForRuntimeUpdate(),
  installRuntimeUpdate: () => installRuntimeUpdate(),
  isTauriRuntime: () => isTauriRuntime(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("1.2.9"),
}));

vi.mock("src/lib/analytics", () => ({
  trackEssentialEvent: vi.fn(),
}));

function updateStub(version: string): RuntimeUpdate {
  return { version } as RuntimeUpdate;
}

function Harness() {
  const { updateAvailable, updateVersion } = useAppUpdater();
  return h(
    "div",
    {
      "data-available": String(updateAvailable),
      "data-version": updateVersion ?? "",
    },
    "updater"
  );
}

describe("useAppUpdater", () => {
  beforeEach(() => {
    checkForRuntimeUpdate.mockReset();
    checkForRuntimeUpdate.mockResolvedValue(null);
    isTauriRuntime.mockReturnValue(false);
  });

  afterEach(() => {
    checkForRuntimeUpdate.mockReset();
  });

  it("checks again when the home window is focused", async () => {
    checkForRuntimeUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(updateStub("1.2.9"));

    const view = render(h(Harness, {}));
    await waitFor(() => expect(checkForRuntimeUpdate).toHaveBeenCalledTimes(1));
    expect(view.container.firstElementChild).toHaveAttribute(
      "data-available",
      "false"
    );

    fireEvent.focus(window);

    await waitFor(() => expect(checkForRuntimeUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(view.container.firstElementChild).toHaveAttribute(
        "data-available",
        "true"
      )
    );
    expect(view.container.firstElementChild).toHaveAttribute(
      "data-version",
      "1.2.9"
    );
  });

  it("checks again when the home screen becomes visible", async () => {
    checkForRuntimeUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(updateStub("1.3.0"));

    const view = render(h(Harness, {}));
    await waitFor(() => expect(checkForRuntimeUpdate).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(checkForRuntimeUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(view.container.firstElementChild).toHaveAttribute(
        "data-version",
        "1.3.0"
      )
    );
  });
});
