import { render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("src/lib/system-dialog", () => ({ confirmDialog: m.confirm }));

import { TabTargetBanner } from "./TabTargetBanner";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import type { ResolvedTabTarget } from "src/lib/tabs/tabTarget";

const ok: ResolvedTabTarget = {
  state: "ok",
  intended: { profileId: "p1", override: null },
  display: "app",
};
const unknown: ResolvedTabTarget = {
  state: "unknown",
  intended: null,
  display: "",
};

let seq = 0;
function staleRuntime() {
  const id = `rt-${++seq}`;
  useRuntimeTargetsStore.getState().register(
    id,
    {
      profile_id: "p1",
      profile_revision: "r1",
      database_override: null,
      engine: "postgres",
      display: "app",
    },
    "tab-1"
  );
  useRuntimeTargetsStore.getState().markRefused(id, "RUNTIME_STALE");
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  useRuntimeTargetsStore.setState({ targets: {}, owners: {}, refused: {} });
});

describe("a tab whose connection must be reconnected", () => {
  it("asks natively and reconnects on Reconnect, with no banner", async () => {
    m.confirm.mockResolvedValue(true);
    const onReconnect = vi.fn();
    const runtimeId = staleRuntime();
    render(
      <TabTargetBanner
        target={ok}
        runtimeId={runtimeId}
        onReconnect={onReconnect}
      />
    );
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(m.confirm).toHaveBeenCalledWith(
      "The connection settings changed. Reconnect this tab.",
      expect.objectContaining({ okLabel: "Reconnect" })
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does nothing on Not now, and asks only once", async () => {
    m.confirm.mockResolvedValue(false);
    const onReconnect = vi.fn();
    const runtimeId = staleRuntime();
    const view = render(
      <TabTargetBanner
        target={ok}
        runtimeId={runtimeId}
        onReconnect={onReconnect}
      />
    );
    await waitFor(() => expect(m.confirm).toHaveBeenCalledTimes(1));
    view.rerender(
      <TabTargetBanner
        target={{ ...ok }}
        runtimeId={runtimeId}
        onReconnect={onReconnect}
      />
    );
    await Promise.resolve();
    expect(m.confirm).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("drops an answer given after the screen was left, and may ask again", async () => {
    let answer!: (ok: boolean) => void;
    m.confirm.mockImplementation(
      () => new Promise<boolean>((r) => (answer = r))
    );
    const onReconnect = vi.fn();
    const runtimeId = staleRuntime();
    const first = render(
      <TabTargetBanner
        target={ok}
        runtimeId={runtimeId}
        onReconnect={onReconnect}
      />
    );
    await waitFor(() => expect(m.confirm).toHaveBeenCalledTimes(1));
    first.unmount();
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onReconnect).not.toHaveBeenCalled();

    // Back on the screen with the same problem: asked again.
    m.confirm.mockResolvedValue(true);
    const again = vi.fn();
    render(
      <TabTargetBanner target={ok} runtimeId={runtimeId} onReconnect={again} />
    );
    await waitFor(() => expect(again).toHaveBeenCalledTimes(1));
    expect(m.confirm).toHaveBeenCalledTimes(2);
  });

  it("drops an answer once the tab moved to another connection", async () => {
    let answer!: (ok: boolean) => void;
    m.confirm.mockImplementation(
      () => new Promise<boolean>((r) => (answer = r))
    );
    const onReconnect = vi.fn();
    const runtimeId = staleRuntime();
    const view = render(
      <TabTargetBanner
        target={ok}
        runtimeId={runtimeId}
        onReconnect={onReconnect}
      />
    );
    await waitFor(() => expect(m.confirm).toHaveBeenCalledTimes(1));
    view.rerender(
      <TabTargetBanner
        target={ok}
        runtimeId="rt-new"
        onReconnect={onReconnect}
      />
    );
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("keeps the banner, without asking, for a tab whose target is unknown", () => {
    render(
      <TabTargetBanner
        target={unknown}
        runtimeId={undefined}
        onReconnect={vi.fn()}
      />
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be determined"
    );
    expect(m.confirm).not.toHaveBeenCalled();
  });
});
