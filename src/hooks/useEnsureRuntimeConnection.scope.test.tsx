import { act, renderHook, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  updateTab: vi.fn(),
  opened: vi.fn(),
  failed: vi.fn(),
  tabs: [] as { id: string }[],
  activeProfileScreen: "tab-a",
}));

vi.mock("src/lib/runtimeConnection", () => ({
  connectProfileOnce: (...a: any[]) => mocks.connect(...a),
  resolveTabRuntimeConnectionId: () => undefined,
}));
vi.mock("src/stores/screen", () => {
  const hook = () => ({
    updateTab: mocks.updateTab,
    activeProfileScreen: mocks.activeProfileScreen,
  });
  return {
    useScreenStore: Object.assign(hook, {
      getState: () => ({ profileTabs: mocks.tabs }),
    }),
  };
});
vi.mock("src/stores/connection", () => ({
  useConnectionStore: { getState: () => ({ tableDataMap: {} }) },
}));
vi.mock("src/stores/connectionLog", () => ({
  recordConnectionSessionOpened: (...a: any[]) => mocks.opened(...a),
  recordConnectionSessionFailed: (...a: any[]) => mocks.failed(...a),
}));
vi.mock("src/lib/analytics", () => ({
  trackEvent: vi.fn(),
  errorCode: () => "CODE",
}));

import { useEnsureRuntimeConnection } from "./useEnsureRuntimeConnection";

const tabA = {
  id: "tab-a",
  profileId: "p-a",
  engine: "sqlite",
  label: "A",
} as any;
const tabB = {
  id: "tab-b",
  profileId: "p-b",
  engine: "sqlite",
  label: "B",
} as any;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabs = [{ id: "tab-a" }, { id: "tab-b" }];
});

describe("useEnsureRuntimeConnection reload scope", () => {
  it("a late failure for tab A does not replace tab B's state", async () => {
    // Initial auto-restore of A fails; then the user reloads A (e.g. after Grant Access).
    mocks.connect.mockRejectedValueOnce(new Error("A_FIRST"));
    const { result, rerender } = renderHook(
      ({ tab }) => useEnsureRuntimeConnection(tab),
      { initialProps: { tab: tabA } }
    );
    await waitFor(() => expect(result.current.error).toBe("A_FIRST"));

    const pendingA = deferred<string>();
    mocks.connect.mockReturnValueOnce(pendingA.promise);
    let reload!: Promise<unknown>;
    act(() => {
      reload = result.current.reload();
    });

    // Switch to B, whose restore fails with its own error.
    mocks.activeProfileScreen = "tab-b";
    mocks.connect.mockRejectedValueOnce(new Error("B_CURRENT"));
    rerender({ tab: tabB });
    await waitFor(() => expect(result.current.error).toBe("B_CURRENT"));

    pendingA.reject(new Error("A_OBSOLETE"));
    await act(async () => {
      await reload;
    });
    expect(result.current.error).toBe("B_CURRENT");
    // A's own record still gets the failure (the tab exists).
    expect(mocks.failed).toHaveBeenCalledWith(tabA, "A_OBSOLETE");
  });

  it("a late success for a closed tab touches nothing", async () => {
    mocks.activeProfileScreen = "tab-a";
    mocks.connect.mockRejectedValueOnce(new Error("A_FIRST"));
    const { result } = renderHook(() => useEnsureRuntimeConnection(tabA));
    await waitFor(() => expect(result.current.error).toBe("A_FIRST"));

    const pendingA = deferred<string>();
    mocks.connect.mockReturnValueOnce(pendingA.promise);
    let reload!: Promise<unknown>;
    act(() => {
      reload = result.current.reload();
    });
    mocks.tabs = [{ id: "tab-b" }]; // tab A closed
    pendingA.resolve("conn-a");
    await act(async () => {
      await reload;
    });
    expect(mocks.updateTab).not.toHaveBeenCalled();
    expect(mocks.opened).not.toHaveBeenCalled();
  });
});
