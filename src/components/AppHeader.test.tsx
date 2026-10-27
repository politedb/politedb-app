import { act, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader";
import { useScreenStore } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";
import { usePinnedConnectionsStore } from "src/stores/pinnedConnections";

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
});
