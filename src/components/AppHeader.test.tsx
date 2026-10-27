import { act, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader";
import { useScreenStore } from "src/stores/screen";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));
vi.mock("src/screens/connection/lib/connectionTabClose", () => ({
  requestCloseConnectionTab: vi.fn(),
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
    expect(first.getAttribute("title")).toBe(
      "prod-analytics-postgres-primary · Postgres"
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
});
