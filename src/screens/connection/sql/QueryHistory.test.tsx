import { render, screen } from "@testing-library/preact";
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
  clearQueryHistory: () => {},
}));
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
