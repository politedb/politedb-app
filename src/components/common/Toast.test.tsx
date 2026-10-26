import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast, useToastStore } from "src/stores/toast";
import { Toast } from "./Toast";

afterEach(() => {
  vi.useRealTimers();
  useToastStore.setState({ toasts: [] });
});

describe("Toast", () => {
  it("renders a toast without an action as before", () => {
    showToast("Saved", { tone: "success", durationMs: 0 });
    render(<Toast />);
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "",
    ]);
  });

  it("runs its action once, holds the toast meanwhile, then dismisses it", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const onClick = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    showToast("Created", {
      tone: "success",
      durationMs: 1000,
      action: { label: "Open", onClick },
    });
    render(<Toast />);
    const button = screen.getByRole("button", { name: "Open" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    // The timer is suspended while the action runs.
    vi.advanceTimersByTime(5000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.useRealTimers();
    finish();
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([]));
  });
});
