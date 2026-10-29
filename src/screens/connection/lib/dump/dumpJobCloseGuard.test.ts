import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDumpJobStore } from "src/stores/dumpJob";
import { useScreenStore } from "src/stores/screen";
import { useUnsavedChangesDialogStore } from "src/stores/unsavedChangesDialog";

/**
 * Closing a tab or the app while a backup or restore runs is refused before
 * any prompt or change (D8), and a close in progress keeps a job from
 * starting in its scope until it is done.
 */

const m = vi.hoisted(() => ({
  showMessage: vi.fn(),
  connectionRemove: vi.fn(async () => {}),
  appQuit: vi.fn(async () => {}),
  saveNow: vi.fn(async () => {}),
  hasChanges: vi.fn(() => false),
  clearChanges: vi.fn(),
  anyUnsaved: vi.fn(() => false),
  discardAll: vi.fn(),
  closeRequested: null as null | ((e: { preventDefault: () => void }) => void),
}));

vi.mock("src/lib/system-dialog", () => ({ showMessage: m.showMessage }));
vi.mock("src/lib/tauri", () => ({ connectionRemove: m.connectionRemove }));
vi.mock("src/lib/tauri/app", () => ({ appQuit: m.appQuit }));
vi.mock("src/lib/tauri/operation", () => ({ operationCancel: vi.fn() }));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: {
    getState: () => ({ scheduleSave: () => {}, saveNow: m.saveNow }),
  },
}));
vi.mock("../tabDirty", () => ({
  connectionTabHasChanges: m.hasChanges,
  clearConnectionTabChanges: m.clearChanges,
}));
vi.mock("../unsavedChanges", () => ({
  hasAnyUnsavedConnectionChanges: m.anyUnsaved,
  discardAllConnectionChanges: m.discardAll,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (
      cb: (e: { preventDefault: () => void }) => void
    ) => {
      m.closeRequested = cb;
      return () => {};
    },
    destroy: vi.fn(),
  }),
}));

import { withCloseAdmission } from "./dumpJobCloseGuard";
import { startDumpJob } from "./dumpJobController";
import {
  discardPendingTabCloseFromDialog,
  requestCloseConnectionTab,
} from "../connectionTabClose";
import {
  connectionTabCloseBridgeFor,
  registerConnectionTabCloseBridge,
} from "../connectionTabCloseBridge";
import { useConnectionQuitGuard } from "../../hooks/useConnectionQuitGuard";

const origin = (tabId = "t1", runtime = "c1") => ({
  tabId,
  runtimeConnectionId: runtime,
  engine: "postgres",
  target: "shop",
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  registerConnectionTabCloseBridge(null);
  useDumpJobStore.setState({ active: null, summary: null, closing: [] });
  useUnsavedChangesDialogStore.getState().close();
  useScreenStore.setState({
    profileTabs: [
      { id: "t1", profileId: "p1", runtimeConnectionId: "c1" },
      { id: "t2", profileId: "p2", runtimeConnectionId: "c2" },
    ] as never,
    openWindows: {},
  } as never);
});

describe("withCloseAdmission", () => {
  it("refuses a close covering a running job, doing nothing", async () => {
    startDumpJob("restore", origin());
    const close = vi.fn();
    expect(
      await withCloseAdmission({ kind: "tab", tabId: "t1" }, undefined, close)
    ).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(m.showMessage).toHaveBeenCalledWith(
      "A backup or restore is running. Cancel it and wait for it to finish, then close.",
      expect.anything()
    );
  });

  it("keeps jobs from starting in its scope until the close ends, even when it throws", async () => {
    let release!: () => void;
    const closing = withCloseAdmission(
      { kind: "tab", tabId: "t1" },
      undefined,
      () =>
        new Promise<void>((_r, reject) => {
          release = () => reject(new Error("save failed"));
        })
    );
    await flush();
    expect(startDumpJob("restore", origin()).ok).toBe(false);
    expect(startDumpJob("restore", origin("t2", "c2")).ok).toBe(true);
    useDumpJobStore.setState({ active: null });
    release();
    await expect(closing).rejects.toThrow("save failed");
    expect(useDumpJobStore.getState().closing).toHaveLength(0);
    expect(startDumpJob("restore", origin()).ok).toBe(true);
  });
});

describe("closing a connection tab", () => {
  it("is refused while its job runs: no prompt, no removal", async () => {
    startDumpJob("backup", origin());
    m.hasChanges.mockReturnValue(true);
    await requestCloseConnectionTab("t1");
    expect(useScreenStore.getState().profileTabs.map((t) => t.id)).toContain(
      "t1"
    );
    expect(
      useUnsavedChangesDialogStore.getState().pendingCloseTabId
    ).toBeNull();
    expect(m.connectionRemove).not.toHaveBeenCalled();
  });

  it("passes its lease to the bridged close, which borrows it", async () => {
    const seen: number[] = [];
    registerConnectionTabCloseBridge({
      closeTab: async (_tabId, _skip, intent) => {
        // The bridged close admits the same scope with the caller's intent.
        await withCloseAdmission({ kind: "tab", tabId: "t1" }, intent, () => {
          seen.push(useDumpJobStore.getState().closing.length);
        });
        seen.push(useDumpJobStore.getState().closing.length);
      },
      discardChanges: async () => {},
    });
    await requestCloseConnectionTab("t1");
    // One lease while nested, still held after the nested close returned.
    expect(seen).toEqual([1, 1]);
    expect(useDumpJobStore.getState().closing).toHaveLength(0);
  });

  it("the screen's real bridge passes the intent on to its close", async () => {
    const closeTab = vi.fn(async () => {});
    registerConnectionTabCloseBridge(
      connectionTabCloseBridgeFor(
        () => ({ closeTab, discardChanges: async () => {} }),
        async () => {}
      )
    );
    await requestCloseConnectionTab("t1");
    expect(closeTab).toHaveBeenCalledWith("t1", false, expect.any(Symbol));
  });

  it("keeps the changes when a job started since the unsaved-changes prompt", async () => {
    useUnsavedChangesDialogStore.getState().openForTabClose("t1");
    startDumpJob("restore", origin());
    await discardPendingTabCloseFromDialog();
    expect(m.clearChanges).not.toHaveBeenCalled();
    expect(m.connectionRemove).not.toHaveBeenCalled();
  });
});

describe("quitting the app", () => {
  it("is refused while a job runs, before the unsaved-changes prompt", async () => {
    renderHook(() => useConnectionQuitGuard());
    await flush();
    startDumpJob("backup", origin());
    m.anyUnsaved.mockReturnValue(true);
    const preventDefault = vi.fn();
    act(() => m.closeRequested!({ preventDefault }));
    await flush();
    expect(preventDefault).toHaveBeenCalled();
    expect(m.appQuit).not.toHaveBeenCalled();
    expect(useUnsavedChangesDialogStore.getState().pendingAppQuit).toBe(false);
    expect(useUnsavedChangesDialogStore.getState().open).toBe(false);
  });

  it("refuses discard-and-quit, keeping the changes, when a job started meanwhile", async () => {
    const { result } = renderHook(() => useConnectionQuitGuard());
    startDumpJob("restore", origin());
    await act(() => result.current.discardAndQuitApp());
    expect(m.discardAll).not.toHaveBeenCalled();
    expect(m.appQuit).not.toHaveBeenCalled();
  });

  it("keeps jobs from starting while the quit saves", async () => {
    let saved!: () => void;
    m.saveNow.mockReturnValue(new Promise<void>((r) => (saved = r)));
    const { result } = renderHook(() => useConnectionQuitGuard());
    let quitting: Promise<void> = Promise.resolve();
    act(() => {
      quitting = result.current.discardAndQuitApp();
    });
    await flush();
    expect(m.discardAll).toHaveBeenCalled();
    expect(startDumpJob("restore", origin("t2", "c2")).ok).toBe(false);
    saved();
    await act(() => quitting);
    expect(m.appQuit).toHaveBeenCalled();
  });
});
