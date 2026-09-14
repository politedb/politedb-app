import { render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlResultRun } from "src/lib/tauri";
import { queryPlanFixture } from "src/test/fixtures/queryPlan";
import { SqlResultsPane } from "./SqlResultsPane";

const state = vi.hoisted(() => ({ streams: {} as Record<string, unknown> }));
vi.mock("src/screens/connection/hooks/useSqlStreamResult", () => ({
  useSqlStreamResult: (id: string | null) =>
    (id && state.streams[id]) || {
      status: "idle",
      columns: [],
      totalRows: 0,
      getRowAt: () => undefined,
    },
}));
vi.mock("src/components/table/TableData", () => ({
  TableData: () => <div>Raw result table</div>,
}));
vi.mock("src/components/table/TableFooter", () => ({
  TableFooter: () => <div>Table footer</div>,
}));
vi.mock("src/components/common/OverlayScrollArea", () => ({
  OverlayScrollArea: ({ children }: { children: preact.ComponentChildren }) => (
    <div>{children}</div>
  ),
}));

const columns = [{ name: "QUERY PLAN", db_type: "json" }];
function run(id = "a"): SqlResultRun {
  return {
    id,
    kind: "explain",
    title: "Explain",
    sql: "select 1",
    createdAt: 1,
    slots: [
      {
        index: 0,
        sql: "EXPLAIN (FORMAT JSON) select 1",
        status: "done",
        mode: "direct",
        result: {
          columns: columns.map((c) => ({ ...c })),
          rows: [[{ t: "Json", v: JSON.stringify(queryPlanFixture) }]],
          rowCount: 1,
        },
      },
    ],
  };
}
const base = {
  engine: "postgres" as const,
  windowId: "w",
  activeRunId: "a",
  setActiveRunId: vi.fn(),
  activeIndex: 0,
  setActiveIndex: vi.fn(),
  onCloseRun: vi.fn(),
};
beforeEach(() => {
  state.streams = {};
});

describe("SQL plan result integration", () => {
  it("renders direct plans and preserves normal results and unsupported engines", () => {
    const view = render(<SqlResultsPane {...base} runs={[run()]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(screen.queryByText("Table footer")).toBeNull();
    view.rerender(<SqlResultsPane {...base} engine="mysql" runs={[run()]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    const mysql = run();
    mysql.slots[0].result!.columns[0] = { name: "EXPLAIN", db_type: "json" };
    mysql.slots[0].result!.rows = [
      [
        {
          t: "Json",
          v: JSON.stringify({
            query_block: {
              table: { table_name: "t", access_type: "ALL", rows: 10 },
            },
          }),
        },
      ],
    ];
    view.rerender(<SqlResultsPane {...base} engine="mysql" runs={[mysql]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    const normal = run();
    normal.kind = "query";
    normal.title = "Query";
    view.rerender(<SqlResultsPane {...base} runs={[normal]} />);
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
    const twoCol = run();
    twoCol.kind = "query";
    twoCol.title = "Query";
    twoCol.slots[0].result!.columns = [
      { name: "id", db_type: "int" },
      { name: "parent", db_type: "int" },
    ];
    twoCol.slots[0].result!.rows = [
      [
        { t: "I64", v: 1 },
        { t: "I64", v: 0 },
      ],
    ];
    view.rerender(<SqlResultsPane {...base} engine="sqlite" runs={[twoCol]} />);
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
    const duckdb = run();
    duckdb.slots[0].result!.columns = [
      { name: "physical_plan", db_type: "text" },
    ];
    duckdb.slots[0].result!.rows = [
      [{ t: "Str", v: "PROJECTION" }],
      [{ t: "Str", v: "  SEQ_SCAN t" }],
    ];
    view.rerender(<SqlResultsPane {...base} engine="duckdb" runs={[duckdb]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /SEQ_SCAN t/ })
    ).toBeInTheDocument();
    const sqlite = run();
    sqlite.slots[0].result!.columns = [
      { name: "id", db_type: "int" },
      { name: "parent", db_type: "int" },
      { name: "notused", db_type: "int" },
      { name: "detail", db_type: "text" },
    ];
    sqlite.slots[0].result!.rows = [
      [
        { t: "I64", v: 2 },
        { t: "I64", v: 0 },
        { t: "I64", v: 0 },
        { t: "Str", v: "SCAN users" },
      ],
    ];
    view.rerender(<SqlResultsPane {...base} engine="sqlite" runs={[sqlite]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /SCAN users/ })
    ).toBeInTheDocument();
  });
  it("uses the active stream immediately when switching runs", () => {
    const streamRun = run();
    streamRun.slots = [
      {
        index: 0,
        sql: "explain",
        mode: "stream",
        opId: "stream-a",
        status: "done",
      },
    ];
    state.streams["stream-a"] = {
      status: "done",
      columns: [{ name: "QUERY PLAN" }],
      totalRows: 1,
      rowsVersion: 1,
      getRowAt: () => [{ t: "Json", v: JSON.stringify(queryPlanFixture) }],
    };
    const view = render(<SqlResultsPane {...base} runs={[streamRun]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    const other = {
      ...streamRun,
      id: "b",
      slots: [
        { ...streamRun.slots[0], opId: "stream-b", status: "running" as const },
      ],
    };
    view.rerender(
      <SqlResultsPane {...base} activeRunId="b" runs={[streamRun, other]} />
    );
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    view.rerender(<SqlResultsPane {...base} runs={[streamRun, other]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
  });
  it("handles empty runs and malformed plan cells", () => {
    const view = render(<SqlResultsPane {...base} runs={[]} />);
    const invalid = run();
    invalid.slots[0].result!.rows = [["bad json"]];
    view.rerender(<SqlResultsPane {...base} runs={[invalid]} />);
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
    view.rerender(<SqlResultsPane {...base} runs={[]} />);
    expect(
      screen.getByText("Run a query to see results here.")
    ).toBeInTheDocument();
  });
});
