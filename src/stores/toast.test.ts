import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast, useToastStore } from "./toast";

describe("toast store", () => {
  afterEach(() => {
    vi.useRealTimers();
    useToastStore.setState({ toasts: [] });
  });

  it("adds a toast and auto-dismisses", () => {
    vi.useFakeTimers();
    const id = showToast("Backup done", { tone: "success", durationMs: 1000 });

    expect(useToastStore.getState().toasts).toEqual([
      { id, message: "Backup done", tone: "success" },
    ]);

    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("dismisses by id", () => {
    const id = showToast("Restore done", {
      tone: "success",
      durationMs: 0,
    });
    useToastStore.getState().dismissToast(id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
