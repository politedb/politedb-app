import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { ConnectionsSection } from "./ConnectionsSection";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

function renderEmpty(searchQuery: string) {
  const handlers = { onCreate: vi.fn(), onClearSearch: vi.fn() };
  render(
    <ConnectionsSection
      profiles={[]}
      pinnedIds={[]}
      viewMode="grid"
      searchQuery={searchQuery}
      groups={[]}
      groupIdsByProfile={{}}
      onUseSqliteTemplate={vi.fn()}
      onOpen={vi.fn()}
      onEdit={vi.fn()}
      onAssignGroups={vi.fn()}
      onSelectProfile={vi.fn()}
      {...handlers}
    />
  );
  return handlers;
}

describe("ConnectionsSection empty states", () => {
  it("offers a new connection and the template when nothing is saved", () => {
    const { onCreate } = renderEmpty("");
    expect(screen.getByText("All connections (0)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New connection" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Start with a SQLite template" })
    ).toBeTruthy();
  });

  it("offers to clear a search that matches nothing", () => {
    const { onClearSearch, onCreate } = renderEmpty("zzz");
    expect(screen.getByText("No matching connections")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClearSearch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "New connection" })).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
