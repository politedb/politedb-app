import { h } from "preact";
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionOpenLogEntry } from "src/types";

const log = vi.hoisted(() => ({
  state: { entries: [] as unknown[], clearLog: vi.fn() },
  confirmDialog: vi.fn(),
}));
// zustand runs on React's hooks; feed the selectors plain state instead.
vi.mock("src/stores/connectionLog", () => ({
  MAX_ENTRIES: 300,
  useConnectionLogStore: (select: (s: unknown) => unknown) => select(log.state),
}));
vi.mock("src/lib/system-dialog", () => ({ confirmDialog: log.confirmDialog }));

import { ConnectionLogsSection } from "./ConnectionLogsSection";

class IntersectionObserverMock {
  observe() {}
  disconnect() {}
}

const now = Date.now();
const min = 60_000;
let seq = 0;
function session(over: Partial<ConnectionOpenLogEntry> = {}) {
  seq += 1;
  return {
    id: `s${seq}`,
    tabId: `t${seq}`,
    profileId: "prod",
    profileLabel: "Prod",
    engine: "postgres",
    host: "db.internal:5432 • app",
    dbUser: "app",
    deviceName: "macbook.local",
    openedAt: now - 30 * min,
    closedAt: now - 20 * min,
    status: "closed",
    ...over,
  } as ConnectionOpenLogEntry;
}

function setup(
  entries: ConnectionOpenLogEntry[],
  props: Partial<Parameters<typeof ConnectionLogsSection>[0]> = {}
) {
  log.state.entries = entries;
  const handlers = {
    onOpenConnection: vi.fn(),
    onShowConnection: vi.fn(),
  };
  render(
    h(ConnectionLogsSection, {
      searchQuery: "",
      knownProfileIds: new Set(["prod", "stage"]),
      ...handlers,
      ...props,
    })
  );
  return handlers;
}

// Connection names also appear in the connection filter, so look in the table.
const table = () => within(screen.getByRole("table"));
const row = (text: string) => table().getByText(text).closest("tr")!;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  log.state.clearLog.mockReset();
  log.confirmDialog.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describe("ConnectionLogsSection", () => {
  it("puts the connection first and groups sessions by day", () => {
    setup([
      session({ profileLabel: "Today DB" }),
      session({
        profileLabel: "Old DB",
        openedAt: now - 3 * 24 * 60 * min,
        closedAt: now - 3 * 24 * 60 * min + 5 * min,
      }),
    ]);

    const headers = screen
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers.slice(0, 3)).toEqual(["Connection", "Status", "Time"]);
    expect(screen.getByText("Today")).toBeTruthy();
    expect(within(row("Today DB")).getByText(/· 10 min/)).toBeTruthy();
    expect(
      screen.getByText("keeps the last 300", { exact: false })
    ).toBeTruthy();
  });

  it("marks open sessions and keeps counting their time", () => {
    setup([
      session({
        status: "active",
        closedAt: undefined,
        openedAt: now - 12 * min,
      }),
    ]);

    const r = row("Prod");
    expect(within(r).getByText("Open")).toBeTruthy();
    expect(within(r).getByText(/open 12 min/)).toBeTruthy();
  });

  it("shows why a session failed, with Retry and Copy error message", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { onOpenConnection } = setup([
      session({ status: "failed", error: "password authentication failed" }),
    ]);

    const r = row("Prod");
    expect(within(r).getByText("password authentication failed")).toBeTruthy();
    fireEvent.click(within(r).getByRole("button", { name: "Retry" }));
    expect(onOpenConnection).toHaveBeenCalledWith("prod");

    fireEvent.contextMenu(r, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText("Copy error message"));
    expect(writeText).toHaveBeenCalledWith("password authentication failed");
  });

  it("opens on double-click or Enter, but not for deleted connections", () => {
    const { onOpenConnection } = setup([
      session(),
      session({
        profileId: "gone",
        profileLabel: "Gone DB",
        status: "failed",
        error: "x",
      }),
    ]);

    fireEvent.dblClick(row("Prod"));
    fireEvent.keyDown(row("Prod"), { key: "Enter" });
    expect(onOpenConnection).toHaveBeenCalledTimes(2);

    fireEvent.dblClick(row("Gone DB"));
    expect(onOpenConnection).toHaveBeenCalledTimes(2);
    expect(
      within(row("Gone DB")).queryByRole("button", { name: "Retry" })
    ).toBeNull();
  });

  it("leaves Enter and double-clicks on its buttons to those buttons", () => {
    const { onOpenConnection } = setup([
      session({ status: "failed", error: "refused" }),
    ]);
    const r = row("Prod");
    const kebab = within(r).getByRole("button", { name: "Open menu" });
    const retry = within(r).getByRole("button", { name: "Retry" });

    fireEvent.keyDown(kebab, { key: "Enter" });
    fireEvent.dblClick(kebab);
    expect(onOpenConnection).not.toHaveBeenCalled();

    // A double-click on Retry: click, click, dblclick.
    fireEvent.click(retry, { detail: 1 });
    fireEvent.click(retry, { detail: 2 });
    fireEvent.dblClick(retry);
    expect(onOpenConnection).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(r, { key: "Enter" });
    expect(onOpenConnection).toHaveBeenCalledTimes(2);
  });

  it("marks the chosen status filter as pressed", () => {
    setup([session()]);
    const all = screen.getByRole("button", { name: /^All \(/ });
    const failed = screen.getByRole("button", { name: /^Failed \(/ });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(failed);
    expect(failed.getAttribute("aria-pressed")).toBe("true");
    expect(all.getAttribute("aria-pressed")).toBe("false");
  });

  it("shortens long hosts in the middle but keeps the database", () => {
    setup([
      session({
        host: "politedb-e1d055c7.pgwss41fhn25j4kyr6drcww6g.c0.ap-southeast-1.aws.pg.clickhouse.cloud:5432 • saltabo",
      }),
    ]);

    const r = row("Prod");
    expect(within(r).getByText(/…/)).toBeTruthy();
    expect(within(r).getByText("• saltabo", { exact: false })).toBeTruthy();
  });

  it("shows the device column only with several devices", () => {
    setup([session(), session({ deviceName: "work-pc" })]);
    expect(screen.getByRole("columnheader", { name: "Device" })).toBeTruthy();
  });

  it("hides the device column for a single device", () => {
    setup([session(), session()]);
    expect(screen.queryByRole("columnheader", { name: "Device" })).toBeNull();
  });

  it("folds back-to-back short sessions into one row", () => {
    const start = now - 10 * min;
    setup([
      session({ openedAt: start, closedAt: start + 5_000 }),
      session({ openedAt: start - 20_000, closedAt: start - 15_000 }),
    ]);

    expect(table().getAllByText("Prod")).toHaveLength(1);
    expect(screen.getByText("×2")).toBeTruthy();
  });

  it("filters by status and by connection", () => {
    setup([
      session({ profileLabel: "Prod ok" }),
      session({ profileLabel: "Prod failed", status: "failed", error: "e" }),
      session({
        profileId: "stage",
        profileLabel: "Stage",
        openedAt: now - 50 * min,
      }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Failed \(1\)/ }));
    expect(table().queryByText("Prod ok")).toBeNull();
    expect(table().getByText("Prod failed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^All \(/ }));
    fireEvent.input(
      screen.getByRole("combobox", { name: "Filter by connection" }),
      {
        target: { value: "stage" },
      }
    );
    expect(table().getByText("Stage")).toBeTruthy();
    expect(table().queryByText("Prod ok")).toBeNull();
  });

  it("clears the history after confirming", async () => {
    setup([session()]);

    fireEvent.click(screen.getByRole("button", { name: /Clear history/ }));
    await vi.waitFor(() => expect(log.state.clearLog).toHaveBeenCalled());
    expect(log.confirmDialog).toHaveBeenCalledWith(
      expect.stringContaining("still open stay"),
      expect.objectContaining({ title: "Clear history" })
    );
  });
});
