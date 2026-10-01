import { act, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRefreshTrigger } from "./useRefreshTrigger";

type Api = ReturnType<typeof useRefreshTrigger>;

let api: Api | null = null;

function Harness({ onRefresh }: { onRefresh?: () => void | Promise<void> }) {
  api = useRefreshTrigger(onRefresh);
  return (
    <div>
      <div data-testid="spinning">{String(api.isRefreshing)}</div>
      <button type="button" onClick={() => void api?.triggerRefresh()}>
        refresh
      </button>
    </div>
  );
}

describe("useRefreshTrigger", () => {
  beforeEach(() => {
    api = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears isRefreshing after a successful refresh (min spin elapsed)", async () => {
    const onRefresh = vi.fn(async () => {});
    render(<Harness onRefresh={onRefresh} />);

    await act(async () => {
      const p = api!.triggerRefresh();
      await vi.advanceTimersByTimeAsync(400);
      await p;
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("spinning").textContent).toBe("false");
  });

  it("clears isRefreshing when refresh rejects (error path)", async () => {
    const onRefresh = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<Harness onRefresh={onRefresh} />);

    await act(async () => {
      const p = api!.triggerRefresh();
      await vi.advanceTimersByTimeAsync(400);
      await p;
    });

    expect(screen.getByTestId("spinning").textContent).toBe("false");
  });

  it("clears isRefreshing when refresh returns immediately (cancel / dirty dialog)", async () => {
    // Mimics openForRefresh() + return — refresh "cancels" into a dialog.
    const onRefresh = vi.fn(() => undefined);
    render(<Harness onRefresh={onRefresh} />);

    let p!: Promise<void>;
    await act(async () => {
      p = api!.triggerRefresh();
    });
    expect(screen.getByTestId("spinning").textContent).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await p;
    });

    expect(screen.getByTestId("spinning").textContent).toBe("false");
  });

  it("ignores overlapping triggers while in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const onRefresh = vi.fn(() => gate);

    render(<Harness onRefresh={onRefresh} />);

    let first!: Promise<void>;
    await act(async () => {
      first = api!.triggerRefresh();
    });
    expect(screen.getByTestId("spinning").textContent).toBe("true");

    await act(async () => {
      await api!.triggerRefresh();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(400);
      await first;
    });

    expect(screen.getByTestId("spinning").textContent).toBe("false");
  });

  it("clears isRefreshing after a slow focused-table reload settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Simulates await loadTableData(activeTableWindow) taking longer than MIN_SPIN.
    const onRefresh = vi.fn(() => gate);
    render(<Harness onRefresh={onRefresh} />);

    let done!: Promise<void>;
    await act(async () => {
      done = api!.triggerRefresh();
    });
    expect(screen.getByTestId("spinning").textContent).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Still spinning until the focused-tab load settles.
    expect(screen.getByTestId("spinning").textContent).toBe("true");

    await act(async () => {
      release();
      await done;
    });

    await waitFor(() =>
      expect(screen.getByTestId("spinning").textContent).toBe("false")
    );
  });
});
