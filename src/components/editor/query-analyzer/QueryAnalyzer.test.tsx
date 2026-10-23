import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryAnalyzer } from "./QueryAnalyzer";
import { parseQueryPlan } from "src/lib/query-analyzer/plan";
import { planFromResult } from "src/lib/query-analyzer/fromResult";
import { queryPlanFixture } from "src/test/fixtures/queryPlan";
import { confirmDialog, saveDialog } from "src/lib/system-dialog";
import { writeTextFile } from "src/lib/system-fs";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import type { LicenseState } from "src/lib/tauri/license";

vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: vi.fn(),
  saveDialog: vi.fn(),
}));
vi.mock("src/lib/system-fs", () => ({ writeTextFile: vi.fn() }));
vi.mock("src/components/common/OverlayScrollArea", () => ({
  OverlayScrollArea: ({ children }: { children: preact.ComponentChildren }) => (
    <div>{children}</div>
  ),
}));
const mount = () =>
  render(<QueryAnalyzer plan={parseQueryPlan(queryPlanFixture)!} />);
const setProAccess = (pro_access: boolean) =>
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
beforeEach(() => {
  vi.resetAllMocks();
  setProAccess(true);
  useProUpgradeStore.setState({ feature: null });
});

describe("Query Analyzer", () => {
  it("selects nodes and displays their details without executing SQL", () => {
    mount();
    expect(screen.getByText("Measured plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Seq Scan on orders/ }));
    expect(screen.getByLabelText("Selected node")).toHaveTextContent(
      "customer_id = 8421"
    );
    fireEvent.click(screen.getByRole("tab", { name: /Recommendations/ }));
    expect(screen.getByText("Sort spilled to disk")).toBeInTheDocument();
    expect(screen.getByText("Execution time")).toBeInTheDocument();
    expect(screen.getByText("2,840 ms")).toBeInTheDocument();
  });
  it("shows extra engine fields on selected MySQL nodes", () => {
    const plan = planFromResult(
      "mysql",
      [
        { name: "id" },
        { name: "select_type" },
        { name: "table" },
        { name: "type" },
        { name: "key" },
        { name: "Extra" },
      ],
      [
        [
          { t: "I64", v: 1 },
          { t: "Str", v: "SIMPLE" },
          { t: "Str", v: "User" },
          { t: "Str", v: "ALL" },
          { t: "Null" },
          { t: "Str", v: "Using where" },
        ],
      ]
    )!;
    render(<QueryAnalyzer plan={plan} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(screen.getByLabelText("Selected node")).toHaveTextContent(
      "Using where"
    );
    expect(screen.getByLabelText("Selected node")).toHaveTextContent("SIMPLE");
  });
  it("filters nodes and exposes every page for large plans", () => {
    const plan = parseQueryPlan({
      Plan: {
        "Node Type": "Append",
        Plans: Array.from({ length: 120 }, (_, i) => ({
          "Node Type": "Seq Scan",
          "Relation Name": `table_${i}`,
        })),
      },
    })!;
    render(<QueryAnalyzer plan={plan} />);
    expect(screen.queryByRole("option", { name: /table_119/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(
      screen.getByRole("option", { name: /table_119/ })
    ).toBeInTheDocument();
    fireEvent.input(screen.getByLabelText("Filter plan nodes"), {
      target: { value: "table_119" },
    });
    expect(
      screen.getByRole("option", { name: /table_119/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });
  it("hides PostgreSQL-omitted metrics on estimated plans", () => {
    const plan = parseQueryPlan({
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "User",
        "Total Cost": 8.88,
        "Plan Rows": 188,
      },
    })!;
    render(<QueryAnalyzer plan={plan} />);
    expect(screen.getByText("Estimated total cost")).toBeInTheDocument();
    expect(screen.getAllByText("8.88").length).toBeGreaterThan(0);
    expect(screen.queryByText("Not available")).toBeNull();
    expect(screen.queryByText("Execution time")).toBeNull();
    expect(screen.getByText(/Estimated by the planner/)).toBeInTheDocument();
    // A single-node plan needs neither a filter nor an order toggle.
    expect(screen.queryByLabelText("Filter plan nodes")).toBeNull();
    expect(screen.queryByRole("group", { name: "Node order" })).toBeNull();
  });
  it("imports a baseline and rejects invalid replacements", async () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    const input = screen.getByLabelText("Baseline JSON plan");
    const read = vi.fn().mockResolvedValue(JSON.stringify(queryPlanFixture));
    fireEvent.input(input, { target: { files: [{ size: 100, text: read }] } });
    expect(read).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText("Baseline")).toBeInTheDocument()
    );
    fireEvent.input(input, {
      target: { files: [{ size: 100, text: async () => "bad" }] },
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Invalid PostgreSQL")
    );
    expect(screen.queryByText("Baseline")).toBeNull();
  });
  it("requires consent before exporting sensitive plans", async () => {
    mount();
    vi.mocked(confirmDialog).mockResolvedValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(saveDialog).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
  it("exports the report through native wrappers and handles write failures", async () => {
    mount();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(saveDialog).mockResolvedValue("/tmp/report.md");
    vi.mocked(writeTextFile).mockRejectedValue(new Error("private path"));
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Export failed")
    );
    expect(screen.queryByText("private path")).toBeNull();
    expect(writeTextFile).toHaveBeenCalledWith(
      "/tmp/report.md",
      expect.stringContaining("# PoliteDB Query Analysis")
    );
    expect(useProUpgradeStore.getState().feature).toBeNull();
  });
  it("exports the JSON plan with Pro", async () => {
    mount();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(saveDialog).mockResolvedValue("/tmp/plan.json");
    vi.mocked(writeTextFile).mockResolvedValue(undefined);
    fireEvent.click(screen.getByTitle("Export JSON plan"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Export complete")
    );
    expect(writeTextFile).toHaveBeenCalledWith(
      "/tmp/plan.json",
      expect.any(String)
    );
  });
  it("shows the Pro badge in the header for every tier", () => {
    const view = mount();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    view.unmount();
    setProAccess(false);
    mount();
    expect(screen.getByText("Pro")).toBeInTheDocument();
  });
  it.each([
    ["Markdown report", "Export Markdown report"],
    ["JSON plan", "Export JSON plan"],
  ])(
    "blocks the %s export without Pro and opens the upgrade dialog",
    async (_label, title) => {
      setProAccess(false);
      mount();
      vi.mocked(confirmDialog).mockResolvedValue(true);
      vi.mocked(saveDialog).mockResolvedValue("/tmp/out");
      fireEvent.click(screen.getByTitle(title));
      await waitFor(() =>
        expect(useProUpgradeStore.getState().feature).toBe("query-analyzer")
      );
      expect(confirmDialog).not.toHaveBeenCalled();
      expect(saveDialog).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
    }
  );

  describe("where the time goes", () => {
    const nestedLoop = () =>
      parseQueryPlan({
        "Execution Time": 1000,
        Plan: {
          "Node Type": "Nested Loop",
          "Total Cost": 500,
          "Actual Total Time": 1000,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "outer_rows",
              "Total Cost": 100,
              "Actual Total Time": 50,
              "Actual Loops": 1,
            },
            {
              "Node Type": "Index Scan",
              "Relation Name": "inner_rows",
              "Total Cost": 4,
              "Actual Total Time": 0.09,
              "Actual Loops": 10000,
              "Parallel Aware": false,
              "Scan Direction": "Forward",
            },
          ],
        },
      })!;

    it("marks the hottest node by its own time over all loops and selects it", () => {
      render(<QueryAnalyzer plan={nestedLoop()} />);
      const hottest = screen.getByRole("option", {
        name: /Index Scan on inner_rows/,
      });
      expect(hottest).toHaveTextContent("Hottest");
      expect(hottest).toHaveTextContent("90%");
      expect(hottest.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText(/Most time · 90%/)).toBeInTheDocument();
      // Details: grouped, false flags hidden.
      const details = screen.getByLabelText("Selected node");
      expect(details).toHaveTextContent("Time, all loops900 ms");
      expect(details).toHaveTextContent("Scan Direction");
      expect(details).not.toHaveTextContent("Parallel Aware");
    });

    it("sorts by own share and collapses branches", () => {
      render(<QueryAnalyzer plan={nestedLoop()} />);
      fireEvent.click(screen.getByRole("button", { name: "Slowest first" }));
      const options = screen.getAllByRole("option").map((o) => o.textContent);
      expect(options[0]).toMatch(/inner_rows/);

      fireEvent.click(screen.getByRole("button", { name: "Plan order" }));
      fireEvent.click(screen.getByRole("button", { name: "Collapse branch" }));
      expect(screen.getAllByRole("option")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Expand branch" }));
      expect(screen.getAllByRole("option")).toHaveLength(3);
    });

    it("moves through nodes with the keyboard", () => {
      render(<QueryAnalyzer plan={nestedLoop()} />);
      const list = screen.getByRole("listbox", { name: "Plan nodes" });
      fireEvent.keyDown(list, { key: "Home" });
      expect(
        screen
          .getByRole("option", { name: /Nested Loop/ })
          .getAttribute("aria-selected")
      ).toBe("true");
      fireEvent.keyDown(list, { key: "ArrowDown" });
      expect(screen.getByLabelText("Selected node")).toHaveTextContent(
        "outer_rows"
      );
      fireEvent.keyDown(list, { key: "End" });
      expect(screen.getByLabelText("Selected node")).toHaveTextContent(
        "inner_rows"
      );
    });

    it("jumps to the hottest node from the summary", () => {
      render(<QueryAnalyzer plan={nestedLoop()} />);
      fireEvent.click(screen.getByRole("option", { name: /Nested Loop/ }));
      fireEvent.click(screen.getByText(/Most time · 90%/));
      expect(screen.getByLabelText("Selected node")).toHaveTextContent(
        "inner_rows"
      );
    });
  });

  it("explains an empty Recommendations tab differently for estimated plans", () => {
    render(
      <QueryAnalyzer
        plan={
          parseQueryPlan({
            Plan: { "Node Type": "Result", "Total Cost": 1 },
          })!
        }
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: /Recommendations/ }));
    expect(
      screen.getByText(/run the statement with EXPLAIN ANALYZE/)
    ).toBeTruthy();
  });

  it("compares with an earlier Explain from the same tab", () => {
    const earlier = parseQueryPlan({
      Plan: { "Node Type": "Seq Scan", "Total Cost": 200 },
    })!;
    const current = parseQueryPlan({
      Plan: { "Node Type": "Index Scan", "Total Cost": 50 },
    })!;
    const load = vi.fn(() => earlier);
    render(
      <QueryAnalyzer
        plan={current}
        baselines={[{ id: "r1:0", title: "Explain 1", load }]}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(load).not.toHaveBeenCalled();
    fireEvent.input(screen.getByRole("combobox"), {
      target: { value: "r1:0" },
    });
    expect(load).toHaveBeenCalledTimes(1);
    const row = screen.getByRole("row", { name: /Estimated total cost/ });
    expect(row).toHaveTextContent("200");
    expect(row).toHaveTextContent("50");
    expect(row).toHaveTextContent("−75%");
  });

  it("offers Run with ANALYZE only when the host provides it", () => {
    const plan = parseQueryPlan({
      Plan: { "Node Type": "Result", "Total Cost": 1 },
    })!;
    const { rerender } = render(<QueryAnalyzer plan={plan} />);
    expect(
      screen.queryByRole("button", { name: "Run with ANALYZE" })
    ).toBeNull();
    const onRunAnalyze = vi.fn();
    rerender(<QueryAnalyzer plan={plan} onRunAnalyze={onRunAnalyze} />);
    fireEvent.click(screen.getByRole("button", { name: "Run with ANALYZE" }));
    expect(onRunAnalyze).toHaveBeenCalled();
  });

  describe("large plans", () => {
    // 150 filtered scans; the last one is by far the most expensive.
    const big = () =>
      parseQueryPlan({
        Plan: {
          "Node Type": "Append",
          "Total Cost": 10000,
          Plans: Array.from({ length: 150 }, (_, i) => ({
            "Node Type": "Seq Scan",
            "Relation Name": `t_${i}`,
            Filter: "(x = 1)",
            "Total Cost": i === 149 ? 5000 : 30,
          })),
        },
      })!;

    it("opens on the hottest node's page with a tabbable row", () => {
      render(<QueryAnalyzer plan={big()} />);
      const hottest = screen.getByRole("option", { name: /t_149/ });
      expect(hottest.getAttribute("aria-selected")).toBe("true");
      expect(hottest.tabIndex).toBe(0);
    });

    it("keeps a row tabbable when the selection is on another page", () => {
      render(<QueryAnalyzer plan={big()} />);
      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
      const tabbable = screen
        .getAllByRole("option")
        .filter((o) => o.tabIndex === 0);
      expect(tabbable).toHaveLength(1);
      tabbable[0]!.focus();
      fireEvent.keyDown(tabbable[0]!, { key: "ArrowDown" });
      expect(screen.getByLabelText("Selected node")).toHaveTextContent("t_0");
    });

    it("pages through more than 100 recommendations", () => {
      render(<QueryAnalyzer plan={big()} />);
      fireEvent.click(screen.getByRole("tab", { name: /Recommendations/ }));
      expect(screen.getByText(/Node 101:/)).toBeTruthy();
      expect(screen.queryByText(/Node 151:/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(screen.getByText(/Node 151:/)).toBeTruthy();
      // Jumping to a node on page two shows it in the tree.
      fireEvent.click(screen.getByText(/Node 151:/));
      expect(
        screen
          .getByRole("option", { name: /t_149/ })
          .getAttribute("aria-selected")
      ).toBe("true");
    });

    it("reveals the hottest node from the summary even from page one", () => {
      render(<QueryAnalyzer plan={big()} />);
      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
      expect(screen.queryByRole("option", { name: /t_149/ })).toBeNull();
      fireEvent.click(screen.getByText(/Most cost/));
      expect(screen.getByRole("option", { name: /t_149/ })).toBeInTheDocument();
    });
  });

  it("keeps the comparison when switching views", () => {
    const earlier = parseQueryPlan({
      Plan: { "Node Type": "Seq Scan", "Total Cost": 200 },
    })!;
    render(
      <QueryAnalyzer
        plan={
          parseQueryPlan({
            Plan: { "Node Type": "Index Scan", "Total Cost": 50 },
          })!
        }
        baselines={[{ id: "r1:0", title: "Explain 1", load: () => earlier }]}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    fireEvent.input(screen.getByRole("combobox"), {
      target: { value: "r1:0" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(
      screen.getByRole("row", { name: /Estimated total cost/ })
    ).toHaveTextContent("−75%");
  });

  it("moves focus to the node revealed from a recommendation", async () => {
    render(<QueryAnalyzer plan={parseQueryPlan(queryPlanFixture)!} />);
    fireEvent.click(screen.getByRole("tab", { name: /Recommendations/ }));
    const shortcut = screen.getAllByRole("button", { name: /^Node 2:/ })[0]!;
    shortcut.focus();
    fireEvent.click(shortcut);
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Seq Scan on orders/ })
      ).toHaveFocus()
    );
    // Revealing the same node again still focuses it.
    fireEvent.click(screen.getByRole("tab", { name: /Recommendations/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Node 2:/ })[0]!);
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Seq Scan on orders/ })
      ).toHaveFocus()
    );
  });

  it("does not replay a used focus request when returning to Plan", async () => {
    render(<QueryAnalyzer plan={parseQueryPlan(queryPlanFixture)!} />);
    fireEvent.click(screen.getByRole("tab", { name: /Recommendations/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Node 2:/ })[0]!);
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Seq Scan on orders/ })
      ).toHaveFocus()
    );
    const recs = screen.getByRole("tab", { name: /Recommendations/ });
    fireEvent.click(recs);
    recs.focus();
    fireEvent.keyDown(recs, { key: "Home" });
    const planTab = screen.getByRole("tab", { name: "Plan" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(planTab).toHaveFocus();
    fireEvent.keyDown(planTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Recommendations/ })).toHaveFocus();
  });

  it("switches tabs with the arrow keys", () => {
    mount();
    const plan = screen.getByRole("tab", { name: "Plan" });
    expect(plan.tabIndex).toBe(0);
    plan.focus();
    fireEvent.keyDown(plan, { key: "ArrowRight" });
    const recs = screen.getByRole("tab", { name: /Recommendations/ });
    expect(recs.getAttribute("aria-selected")).toBe("true");
    expect(recs).toHaveFocus();
    fireEvent.keyDown(recs, { key: "End" });
    expect(screen.getByRole("tab", { name: "JSON" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "JSON" }), {
      key: "ArrowRight",
    });
    expect(screen.getByRole("tab", { name: "Plan" })).toHaveFocus();
  });
});
