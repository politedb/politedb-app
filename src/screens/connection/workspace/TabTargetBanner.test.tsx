import { act, render, screen, waitFor } from "@testing-library/preact";
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
const other: ResolvedTabTarget = {
  state: "ok",
  intended: { profileId: "p1", override: "other" },
  display: "other",
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

/** The native dialog, answered when the test says so. */
function deferredDialogs() {
  const answers: Array<(ok: boolean) => void> = [];
  m.confirm.mockImplementation(
    () => new Promise<boolean>((r) => answers.push(r))
  );
  return {
    count: () => answers.length,
    answer: async (index: number, value: boolean) => {
      await act(async () => {
        answers[index]!(value);
        await Promise.resolve();
      });
    },
  };
}

function banner(
  props: Partial<Parameters<typeof TabTargetBanner>[0]> & {
    runtimeId: string;
  }
) {
  return (
    <TabTargetBanner
      tabId="tab-1"
      target={ok}
      onReconnect={vi.fn()}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useRuntimeTargetsStore.setState({ targets: {}, owners: {}, refused: {} });
});

describe("the reconnect question", () => {
  it("asks natively and reconnects on Reconnect, with no banner", async () => {
    m.confirm.mockResolvedValue(true);
    const onReconnect = vi.fn();
    render(banner({ runtimeId: staleRuntime(), onReconnect }));
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
    const view = render(banner({ runtimeId, onReconnect }));
    await waitFor(() => expect(m.confirm).toHaveBeenCalledTimes(1));
    view.rerender(banner({ runtimeId, onReconnect, target: { ...ok } }));
    view.unmount();
    render(banner({ runtimeId, onReconnect }));
    await act(async () => {});
    expect(m.confirm).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("gives the answer to the screen shown when it comes (left and back before answering)", async () => {
    const dialogs = deferredDialogs();
    const runtimeId = staleRuntime();
    const first = vi.fn();
    const second = vi.fn();
    const before = render(banner({ runtimeId, onReconnect: first }));
    await waitFor(() => expect(dialogs.count()).toBe(1));
    before.unmount();
    render(banner({ runtimeId, onReconnect: second }));
    await act(async () => {});
    expect(dialogs.count()).toBe(1); // never two dialogs
    await dialogs.answer(0, true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("authorizes nothing when answered with no screen showing it, and asks again later", async () => {
    const dialogs = deferredDialogs();
    const runtimeId = staleRuntime();
    const onReconnect = vi.fn();
    const view = render(banner({ runtimeId, onReconnect }));
    await waitFor(() => expect(dialogs.count()).toBe(1));
    view.unmount();
    await dialogs.answer(0, true);
    expect(onReconnect).not.toHaveBeenCalled();

    const again = vi.fn();
    render(banner({ runtimeId, onReconnect: again }));
    await waitFor(() => expect(dialogs.count()).toBe(2));
    await dialogs.answer(1, true);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("never uses an answer for a tab whose target changed meanwhile (same message)", async () => {
    const dialogs = deferredDialogs();
    const runtimeId = staleRuntime();
    const onReconnect = vi.fn();
    const view = render(banner({ runtimeId, onReconnect }));
    await waitFor(() => expect(dialogs.count()).toBe(1));
    view.rerender(banner({ runtimeId, onReconnect, target: other }));
    await dialogs.answer(0, true);
    expect(onReconnect).not.toHaveBeenCalled();
    // The new situation is asked about on its own.
    await waitFor(() => expect(dialogs.count()).toBe(2));
    await dialogs.answer(1, true);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("never uses an answer once the tab moved to another connection", async () => {
    const dialogs = deferredDialogs();
    const onReconnect = vi.fn();
    const view = render(banner({ runtimeId: staleRuntime(), onReconnect }));
    await waitFor(() => expect(dialogs.count()).toBe(1));
    view.rerender(banner({ runtimeId: "rt-fresh", onReconnect }));
    await dialogs.answer(0, true);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("never uses an answer for another tab", async () => {
    const dialogs = deferredDialogs();
    const runtimeId = staleRuntime();
    const first = vi.fn();
    const view = render(banner({ runtimeId, onReconnect: first }));
    await waitFor(() => expect(dialogs.count()).toBe(1));
    view.unmount();
    const otherTab = vi.fn();
    render(banner({ runtimeId, onReconnect: otherTab, tabId: "tab-2" }));
    await dialogs.answer(0, true);
    expect(first).not.toHaveBeenCalled();
    expect(otherTab).not.toHaveBeenCalled();
    // tab-2 is asked about itself once the first dialog is gone.
    await waitFor(() => expect(dialogs.count()).toBe(2));
    await dialogs.answer(1, false);
  });

  it("keeps the banner, without asking, for a tab whose target is unknown", () => {
    render(
      <TabTargetBanner
        tabId="tab-1"
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
