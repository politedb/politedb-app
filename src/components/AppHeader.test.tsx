import { act, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader";
import { useScreenStore } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";
import { usePinnedConnectionsStore } from "src/stores/pinnedConnections";
import { useConnectionStore } from "src/stores/connection";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));
const closeTab = vi.hoisted(() => vi.fn());
vi.mock("src/screens/connection/lib/connectionTabClose", () => ({
  requestCloseConnectionTab: closeTab,
}));

const tab = (id: string, label: string) => ({
  id,
  label,
  engine: "postgres" as const,
  profileId: `p-${id}`,
});

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  closeTab.mockClear();
  useProfileStore.setState({ profiles: [] });
  usePinnedConnectionsStore.setState({ pinnedIds: [] });
  useConnectionStore.setState({ dataPatchMap: {}, newTableData: {} } as never);
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  useScreenStore.setState({
    profileTabs: [
      tab("tab-1", "prod-analytics-postgres-primary"),
      tab("tab-2", "local"),
      tab("tab-3", "reporting"),
    ],
    activeProfileScreen: "tab-1",
  });
});

afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

describe("AppHeader connection tabs", () => {
  it("shows the full name and engine of a tab on hover", () => {
    render(<AppHeader />);
    const first = screen.getAllByRole("tab")[0]!;
    expect(first.getAttribute("title")).toMatch(
      /^prod-analytics-postgres-primary · Postgres · (⌘1|Ctrl\+1)$/
    );
  });

  it("scrolls the active tab into view when it changes", () => {
    render(<AppHeader />);
    scrollIntoView.mockClear();
    act(() => useScreenStore.setState({ activeProfileScreen: "tab-3" }));
    expect(scrollIntoView).toHaveBeenCalled();
    const contexts = scrollIntoView.mock.contexts;
    const scrolled = contexts[contexts.length - 1] as HTMLElement;
    expect(scrolled.textContent).toContain("reporting");
  });

  it("fades the edge that hides more tabs", () => {
    render(<AppHeader />);
    const strip = screen.getAllByRole("tab")[0]!.parentElement!;
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 900 },
    });
    strip.scrollLeft = 0;
    fireEvent.scroll(strip);
    expect(screen.queryByTestId("tabs-fade-left")).toBeNull();
    expect(screen.getByTestId("tabs-fade-right")).toBeTruthy();

    strip.scrollLeft = 600;
    fireEvent.scroll(strip);
    expect(screen.getByTestId("tabs-fade-left")).toBeTruthy();
    expect(screen.queryByTestId("tabs-fade-right")).toBeNull();
  });

  it("does not promise a Close All shortcut that does nothing", () => {
    render(<AppHeader />);
    fireEvent.contextMenu(screen.getAllByRole("tab")[1]!);
    expect(screen.getByText("Close All")).toBeTruthy();
    expect(screen.queryByText("⌘⇧W")).toBeNull();
  });

  it("is one tab stop; arrows move focus and Enter switches", () => {
    render(<AppHeader />);
    const tabs = screen.getAllByRole("tab");
    expect(screen.getByRole("tablist", { name: "Connections" })).toBeTruthy();
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);

    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    // Moving focus does not switch connections.
    expect(useScreenStore.getState().activeProfileScreen).toBe("tab-1");

    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    fireEvent.keyDown(tabs[2]!, { key: "Enter" });
    expect(useScreenStore.getState().activeProfileScreen).toBe("tab-3");
  });

  it("closes a tab with Delete, a middle click or its labelled button", () => {
    render(<AppHeader />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[1]!, { key: "Delete" });
    expect(closeTab).toHaveBeenLastCalledWith("tab-2");
    fireEvent.mouseUp(tabs[2]!, { button: 1 });
    expect(closeTab).toHaveBeenLastCalledWith("tab-3");
    fireEvent.click(screen.getByRole("button", { name: "Close local" }));
    expect(closeTab).toHaveBeenLastCalledWith("tab-2");
    expect(closeTab).toHaveBeenCalledTimes(3);
  });

  it("opens the tab menu from the keyboard", () => {
    render(<AppHeader />);
    fireEvent.keyDown(screen.getAllByRole("tab")[0]!, {
      key: "F10",
      shiftKey: true,
    });
    expect(screen.getByText("Close Others")).toBeTruthy();
  });

  it("opens a saved connection from the + menu, pinned ones first", () => {
    useProfileStore.setState({
      profiles: [
        { id: "a", label: "Analytics", engine: "postgres" },
        { id: "z", label: "Zeta", engine: "mysql" },
      ] as never,
    });
    usePinnedConnectionsStore.setState({ pinnedIds: ["z"] });
    render(<AppHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Open a connection" }));
    const items = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim());
    expect(items).toEqual(["Zeta", "Analytics", "All connections…"]);

    fireEvent.click(screen.getByRole("menuitem", { name: /Analytics/ }));
    const state = useScreenStore.getState();
    const opened = state.profileTabs[state.profileTabs.length - 1]!;
    expect(opened).toMatchObject({ label: "Analytics", profileId: "a" });
    expect(state.activeProfileScreen).toBe(opened.id);
  });

  it("goes to Databases from + when nothing is saved yet", () => {
    render(<AppHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Open a connection" }));
    expect(useScreenStore.getState().activeProfileScreen).toBe("main");
  });

  it("marks a guarded connection with its safety mode color", () => {
    useScreenStore.setState({
      profileTabs: [
        { ...tab("tab-1", "prod"), querySafetyMode: "production" },
        { ...tab("tab-2", "locked"), isLocked: true },
        tab("tab-3", "plain"),
      ],
    });
    const { container } = render(<AppHeader />);
    const stripes = Array.from(
      container.querySelectorAll<HTMLElement>("[data-safety-mode]")
    );
    expect(stripes.map((el) => el.dataset.safetyMode)).toEqual([
      "production",
      "lock",
    ]);
    expect(stripes[0]!.className).toContain("bg-amber-500");
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]!.getAttribute("title")).toContain("Production mode");
    expect(tabs[0]!.textContent).toContain("Production mode");
    expect(tabs[2]!.getAttribute("title")).not.toContain("mode");
  });

  it("shows a dot on a tab with unsaved row changes", () => {
    const { container } = render(<AppHeader />);
    expect(container.querySelector("[data-unsaved-dot]")).toBeNull();
    act(() =>
      useConnectionStore.setState({
        dataPatchMap: {
          "tab-2": {
            w1: { patches: { update: { data: { "0": { name: "x" } } } } },
          },
        },
      } as never)
    );
    const dots = container.querySelectorAll("[data-unsaved-dot]");
    expect(dots).toHaveLength(1);
    const second = screen.getAllByRole("tab")[1]!;
    expect(second.contains(dots[0]!)).toBe(true);
    expect(second.getAttribute("title")).toContain("Unsaved changes");
  });

  it("moves the tab stop with focus, and back to the active tab on a switch", () => {
    render(<AppHeader />);
    const tabs = () => screen.getAllByRole("tab");
    tabs()[0]!.focus();
    fireEvent.keyDown(tabs()[0]!, { key: "ArrowRight" });
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(tabs()[1]!, { key: "Home" });
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tabs()[0]!, { key: "End" });
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, 0]);

    // Switched elsewhere (a shortcut, the sidebar): the stop follows.
    act(() => useScreenStore.setState({ activeProfileScreen: "tab-2" }));
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);

    // The focused tab goes away: the stop falls back to the active one.
    tabs()[2]!.focus();
    act(() =>
      useScreenStore.setState({
        profileTabs: useScreenStore.getState().profileTabs.slice(0, 2),
      })
    );
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0]);
  });

  it("focuses the tab menu opened from the keyboard and gives focus back", () => {
    render(<AppHeader />);
    const first = screen.getAllByRole("tab")[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: "F10", shiftKey: true });
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(document.activeElement).toBe(first);
  });

  it("focuses the first entry of the + menu", () => {
    useProfileStore.setState({
      profiles: [{ id: "a", label: "Analytics", engine: "postgres" }] as never,
    });
    render(<AppHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Open a connection" }));
    const item = screen.getByRole("menuitem", { name: /Analytics/ });
    expect(document.activeElement).toBe(item);
  });

  it("keeps focus in the strip after closing a tab from its menu", async () => {
    closeTab.mockImplementation(async (id: string) => {
      const state = useScreenStore.getState();
      useScreenStore.setState({
        profileTabs: state.profileTabs.filter((t) => t.id !== id),
      });
    });
    render(<AppHeader />);
    const second = screen.getAllByRole("tab")[1]!;
    second.focus();
    fireEvent.keyDown(second, { key: "F10", shiftKey: true });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("menuitem")[0]!);
    });
    expect(closeTab).toHaveBeenCalledWith("tab-2");
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    expect(document.activeElement?.textContent).toContain("prod-analytics");
    closeTab.mockReset();
  });

  it("brings the active tab back when the strip gets narrower", () => {
    let onResize!: () => void;
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          onResize = cb;
        }
        observe = observe;
        disconnect() {}
      }
    );
    try {
      render(<AppHeader />);
      const strip = screen.getByRole("tablist");
      scrollIntoView.mockClear();
      // Same width (a tab added or scrolled): no jump back.
      onResize();
      expect(scrollIntoView).not.toHaveBeenCalled();
      Object.defineProperty(strip, "clientWidth", {
        configurable: true,
        value: 240,
      });
      onResize();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      const contexts = scrollIntoView.mock.contexts;
      expect((contexts[0] as HTMLElement).getAttribute("aria-selected")).toBe(
        "true"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
