import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  queryHistory: {
    "tab-1": [
      { sql: "select 1", timestamp: new Date(1) },
      { sql: "select 2", timestamp: new Date(2), kind: "explain_analyze" },
    ],
    "tab-2": [
      { sql: "select 3", timestamp: new Date(3), kind: "explain_analyze" },
    ],
  },
  clearQueryHistory: vi.fn(),
}));
const confirmDialog = vi.hoisted(() => vi.fn());
vi.mock("src/lib/system-dialog", () => ({ confirmDialog }));
vi.mock("src/stores/connection", () => ({
  useConnectionStore: (select: (s: typeof store) => unknown) => select(store),
}));

import { QueryHistory } from "./QueryHistory";

describe("QueryHistory Explain Analyze entries", () => {
  it("tags Explain Analyze entries and still renders old ones", () => {
    const { container } = render(<QueryHistory activeProfileId="tab-1" />);
    const text = container.textContent ?? "";
    expect(text).toContain("select 1");
    expect(text).toContain("select 2");
    expect(text).not.toContain("select 3");
    expect(screen.getAllByText("Explain Analyze")).toHaveLength(1);
  });
});

describe("QueryHistory actions", () => {
  it("asks before clearing, and clears only when confirmed", async () => {
    render(<QueryHistory activeProfileId="tab-1" />);
    confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTitle("Clear history"));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(store.clearQueryHistory).not.toHaveBeenCalled();

    confirmDialog.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTitle("Clear history"));
    await waitFor(() =>
      expect(store.clearQueryHistory).toHaveBeenCalledWith("tab-1")
    );
  });

  it("filters by the search text", () => {
    const { container } = render(<QueryHistory activeProfileId="tab-1" />);
    fireEvent.input(
      screen.getByRole("searchbox", { name: "Search SQL history" }),
      {
        target: { value: "select 2" },
      }
    );
    expect(container.textContent).toContain("select 2");
    expect(container.textContent).not.toContain("select 1");

    fireEvent.input(
      screen.getByRole("searchbox", { name: "Search SQL history" }),
      {
        target: { value: "nothing" },
      }
    );
    expect(screen.getByText("No query matches the search")).toBeTruthy();
  });

  it("inserts an entry into the SQL editor", () => {
    const onInsertSql = vi.fn();
    render(<QueryHistory activeProfileId="tab-1" onInsertSql={onInsertSql} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Insert into the SQL editor" })[0]!
    );
    expect(onInsertSql).toHaveBeenCalledWith("select 1");
  });
});
