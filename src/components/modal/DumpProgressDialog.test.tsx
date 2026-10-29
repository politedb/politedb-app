import { act, fireEvent, render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDumpJobStore } from "src/stores/dumpJob";
import { useScreenStore } from "src/stores/screen";
import {
  setDumpProgressScheduler,
  startDumpJob,
  type DumpJobHandle,
} from "src/screens/connection/lib/dump/dumpJobController";
import { DumpProgressDialog } from "./DumpProgressDialog";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

function start(kind: "backup" | "restore" = "restore"): DumpJobHandle {
  const started = startDumpJob(kind, {
    tabId: "t1",
    runtimeConnectionId: "c1",
    engine: "postgres",
    target: "shop (shop_db)",
  });
  if (!started.ok) throw new Error(started.message);
  return started.job;
}

beforeEach(() => {
  useDumpJobStore.setState({ active: null, summary: null, closing: [] });
  useScreenStore.setState({
    profileTabs: [
      { id: "t1", profileId: "p1", runtimeConnectionId: "c1" },
    ] as never,
  });
  setDumpProgressScheduler((flush) => flush());
});

describe("DumpProgressDialog", () => {
  it("stays hidden while the native prompts come first, then stays shown", () => {
    const job = start();
    render(<DumpProgressDialog />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    act(() => job.setPhase("confirming", false));
    expect(screen.queryByRole("progressbar")).toBeNull();
    act(() => job.setPhase("running", true));
    expect(screen.getByText("Restoring into shop (shop_db)")).toBeTruthy();
    // Touch ID asked mid-run: still shown.
    act(() => job.setPhase("authenticating", false));
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("shows progress and counts", () => {
    const job = start();
    render(<DumpProgressDialog />);
    act(() => {
      job.setPhase("running", true);
      job.progress({
        stepsTotal: 4,
        stepsDone: 3,
        counts: { completed: 2, skipped: 1, unknown: 0, total: 4 },
        detail: "INSERT INTO a …",
      });
    });
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("75");
    expect(screen.getByText("2 of 4 ran · 1 skipped")).toBeTruthy();
    expect(screen.getByText("INSERT INTO a …")).toBeTruthy();
  });

  it("cancels through the controller, once", async () => {
    const job = start();
    const action = vi.fn(async () => ({
      kind: "accepted" as const,
      evidence: "not-committed-closed" as const,
    }));
    job.setCancelAction(action);
    render(<DumpProgressDialog />);
    act(() => job.setPhase("running", true));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await act(async () => {
      fireEvent.click(cancel);
    });
    expect(action).toHaveBeenCalledTimes(1);
    const cancelling = screen.getByRole("button", { name: "Cancelling…" });
    expect((cancelling as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Cancel during COMMIT, saying why", () => {
    const job = start();
    render(<DumpProgressDialog />);
    act(() => job.setPhase("committing", false));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Committing: this can no longer be cancelled.")
    ).toBeTruthy();
  });

  it("says a cancel during compression waits for it", () => {
    const job = start("backup");
    render(<DumpProgressDialog />);
    act(() => {
      job.setPhase("compressing", true);
      useDumpJobStore.setState({
        active: {
          ...useDumpJobStore.getState().active!,
          cancel: { kind: "requested" },
        },
      });
    });
    expect(
      screen.getByText("Cancelling — waiting for compression to finish…")
    ).toBeTruthy();
  });

  it("asks Stop or Continue with the settled counts", async () => {
    const job = start();
    render(<DumpProgressDialog />);
    act(() => job.setPhase("running", true));
    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => {
      answer = job.askStop({ completed: 3, skipped: 1, unknown: 0, total: 9 });
    });
    expect(
      screen.getByText(/3 of 9 statements ran and stay in the database/)
    ).toBeTruthy();
    // Cancel is not offered on top of the question.
    expect(
      (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await answer).toBe(true);
  });

  it("offers Try again and Stop trying after a failed cancel", async () => {
    const job = start();
    render(<DumpProgressDialog />);
    act(() => job.setPhase("running", true));
    let choice: Promise<"retry" | "stop"> = Promise.resolve("retry");
    act(() => {
      choice = job.offerRetry("The transaction could not be closed.");
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "The transaction could not be closed."
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop trying" }));
    expect(await choice).toBe("stop");
  });

  it("ignores Esc while the job runs", () => {
    const job = start();
    render(<DumpProgressDialog />);
    act(() => job.setPhase("running", true));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("keeps a result to read until Close", async () => {
    const job = start();
    render(<DumpProgressDialog />);
    act(() => job.setPhase("running", true));
    await act(() =>
      job.finish({
        kind: "cancelled",
        rollback: "rolled-back",
        message: "Cancelled. The transaction was rolled back.",
      })
    );
    expect(
      screen.getByText("Cancelled. The transaction was rolled back.")
    ).toBeTruthy();
    expect(
      startDumpJob("backup", {
        tabId: "t1",
        runtimeConnectionId: "c1",
        engine: "postgres",
        target: "",
      }).ok
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useDumpJobStore.getState().summary).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("closes quietly after a success", async () => {
    const job = start();
    render(<DumpProgressDialog />);
    act(() => job.setPhase("running", true));
    await act(() => job.finish({ kind: "succeeded", skipped: 0 }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
