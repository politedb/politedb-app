import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryAnalyzer } from "./QueryAnalyzer";
import { parseQueryPlan } from "src/lib/query-analyzer/plan";
import { planFromResult } from "src/lib/query-analyzer/fromResult";
import { queryPlanFixture } from "src/test/fixtures/queryPlan";
import { confirmDialog, saveDialog } from "src/lib/system-dialog";
import { writeTextFile } from "src/lib/system-fs";

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
beforeEach(() => vi.resetAllMocks());

describe("Query Analyzer", () => {
  it("selects nodes and displays their details without executing SQL", () => {
    mount();
    expect(
      screen.getAllByTitle("Actual inclusive time relative to root").length
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /2. Seq Scan/ }));
    expect(screen.getByLabelText("Selected node")).toHaveTextContent(
      "customer_id = 8421"
    );
    fireEvent.click(screen.getByRole("button", { name: /Recommendations/ }));
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
    expect(
      screen.getAllByTitle("Estimated inclusive cost relative to root").length
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /table_119/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(
      screen.getByRole("button", { name: /table_119/ })
    ).toBeInTheDocument();
    fireEvent.input(screen.getByLabelText("Filter plan nodes"), {
      target: { value: "table_119" },
    });
    expect(
      screen.getByRole("button", { name: /table_119/ })
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
    expect(
      screen.getByText(/omitted when the database did not return them/)
    ).toBeInTheDocument();
  });
  it("imports a baseline and rejects invalid replacements", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
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
  });
});
