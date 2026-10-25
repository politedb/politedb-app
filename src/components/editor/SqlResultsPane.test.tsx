import { act, fireEvent, render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "preact/hooks";
import type { SqlResultRun } from "src/lib/tauri";
import { queryPlanFixture } from "src/test/fixtures/queryPlan";
import { SqlResultsPane } from "./SqlResultsPane";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import type { LicenseState } from "src/lib/tauri/license";

const state = vi.hoisted(() => ({
  streams: {} as Record<string, unknown>,
  tableProps: [] as Record<string, unknown>[],
}));
const idleStream = {
  status: "idle",
  columns: [],
  totalRows: 0,
  getRowAt: () => undefined,
};
vi.mock("src/screens/connection/hooks/useSqlStreamResult", () => ({
  useSqlStreamResult: (id: string | null) =>
    (id && state.streams[id]) || idleStream,
  getSqlStreamSnapshot: (id: string) => state.streams[id] || idleStream,
}));
vi.mock("src/components/table/TableData", () => ({
  TableData: (props: Record<string, unknown>) => {
    state.tableProps.push(props);
    return <div>Raw result table</div>;
  },
}));
vi.mock("src/components/common/Popover", () => ({
  Popover: ({ children, content, open }: any) => (
    <div>
      {children}
      {open ? content : null}
    </div>
  ),
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
const setProAccess = (pro_access: boolean) =>
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
const BANNER = "Visual analyzer and recommendations are Pro";
beforeEach(() => {
  state.streams = {};
  state.tableProps = [];
  setProAccess(true);
  useProUpgradeStore.setState({ feature: null });
});

describe("SQL plan result integration", () => {
  it("renders direct plans and preserves normal results and unsupported engines", () => {
    const view = render(<SqlResultsPane {...base} runs={[run()]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    // The analyzer replaces the result summary line.
    expect(screen.queryByText(/^1 row/)).toBeNull();
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
    normal.slots[0].sql = "select plan from saved_plans";
    view.rerender(<SqlResultsPane {...base} runs={[normal]} />);
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
    const twoCol = run();
    twoCol.kind = "query";
    twoCol.title = "Query";
    twoCol.slots[0].sql = "select id, parent from t";
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
      screen.getByRole("option", { name: /SEQ_SCAN t/ })
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
      screen.getByRole("option", { name: /SCAN users/ })
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

describe("EXPLAIN typed by the user", () => {
  it("opens the analyzer when the result is a plan", () => {
    const typed = run();
    typed.kind = "query";
    typed.title = "Query";
    typed.slots[0].sql =
      "-- measure\nEXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select 1";
    render(<SqlResultsPane {...base} runs={[typed]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(screen.getByText("Measured plan")).toBeInTheDocument();
  });

  it("keeps the raw grid when a typed EXPLAIN returns no plan document", () => {
    const text = run();
    text.kind = "query";
    text.slots[0].sql = "EXPLAIN select 1";
    text.slots[0].result!.rows = [
      [{ t: "Str", v: "Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)" }],
    ];
    render(<SqlResultsPane {...base} runs={[text]} />);
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
  });

  it("offers earlier streamed explains, never later ones", () => {
    const streamed = run("s");
    streamed.kind = "query";
    streamed.title = "Query 1";
    streamed.createdAt = 1;
    streamed.slots[0] = {
      index: 0,
      sql: "EXPLAIN (ANALYZE, FORMAT JSON) select 1",
      status: "done",
      mode: "stream",
      opId: "op-1",
    };
    state.streams["op-1"] = {
      status: "done",
      columns: [{ name: "QUERY PLAN", db_type: "json" }],
      totalRows: 1,
      getRowAt: (i: number) =>
        i === 0
          ? [{ t: "Json", v: JSON.stringify(queryPlanFixture) }]
          : undefined,
    };
    const current = run("c");
    current.title = "Explain 2";
    current.createdAt = 2;
    const later = run("l");
    later.title = "Explain 3";
    later.createdAt = 3;
    render(
      <SqlResultsPane
        {...base}
        activeRunId="c"
        runs={[streamed, current, later]}
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(screen.getByRole("option", { name: "Query 1" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Explain 3" })).toBeNull();
    fireEvent.input(screen.getByRole("combobox"), {
      target: { value: "s:0" },
    });
    expect(
      screen.getByRole("row", { name: /Execution time/ })
    ).toBeInTheDocument();
  });

  it("offers earlier explains in this tab for Compare", () => {
    const first = run("a");
    const second = run("b");
    second.title = "Explain 2";
    second.createdAt = 2;
    render(<SqlResultsPane {...base} activeRunId="b" runs={[first, second]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(screen.getByRole("option", { name: "Explain" })).toBeInTheDocument();
  });
});

describe("SQL plan results without Pro", () => {
  it("shows raw explain rows with an upgrade banner instead of the analyzer", () => {
    setProAccess(false);
    render(<SqlResultsPane {...base} runs={[run()]} />);
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 row");
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(useProUpgradeStore.getState().feature).toBe("query-analyzer");
  });
  it("shows raw rows for streamed explain results", () => {
    setProAccess(false);
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
    render(<SqlResultsPane {...base} runs={[streamRun]} />);
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
  });
  it("re-evaluates when the tier changes while the pane is open", () => {
    setProAccess(false);
    render(<SqlResultsPane {...base} runs={[run()]} />);
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    act(() => setProAccess(true));
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(screen.queryByText(BANNER)).toBeNull();
    act(() => setProAccess(false));
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
  });
  it("leaves errors and ordinary query results unchanged", () => {
    setProAccess(false);
    const failed = run();
    failed.slots[0] = {
      ...failed.slots[0],
      status: "error",
      result: undefined,
      error: "syntax error",
    };
    const view = render(<SqlResultsPane {...base} runs={[failed]} />);
    expect(screen.getByText("syntax error")).toBeInTheDocument();
    expect(screen.queryByText(BANNER)).toBeNull();
    const normal = run();
    normal.kind = "query";
    normal.slots[0].sql = "select plan from saved_plans";
    view.rerender(<SqlResultsPane {...base} runs={[normal]} />);
    expect(screen.getByText("Raw result table")).toBeInTheDocument();
    expect(screen.queryByText(BANNER)).toBeNull();
    // A statement the user ran as EXPLAIN gets the upgrade banner too.
    const typed = run();
    typed.kind = "query";
    typed.slots[0].sql =
      "/* measure */ EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select 1";
    view.rerender(<SqlResultsPane {...base} runs={[typed]} />);
    expect(screen.getByText(BANNER)).toBeInTheDocument();
  });
});

describe("Run with ANALYZE", () => {
  const estimated = [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 5 } }];
  function estimatedRun(): SqlResultRun {
    const r = run();
    r.connectionId = "conn-1";
    // The run keeps the editor text; the slot keeps the statement measured.
    r.sql = "-- picked\nselect 1; -- tail";
    r.slots[0].sourceSql = "select 1";
    r.slots[0].result!.rows = [[{ t: "Json", v: JSON.stringify(estimated) }]];
    return r;
  }

  it("asks to measure the slot's own statement and connection", () => {
    const onRunAnalyze = vi.fn();
    render(
      <SqlResultsPane
        {...base}
        runs={[estimatedRun()]}
        onRunAnalyze={onRunAnalyze}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Run with ANALYZE" }));
    expect(onRunAnalyze).toHaveBeenCalledWith({
      sql: "select 1",
      connectionId: "conn-1",
    });
  });

  it("is not offered for measured plans, typed EXPLAIN or without a handler", () => {
    const onRunAnalyze = vi.fn();
    const view = render(
      <SqlResultsPane {...base} runs={[run()]} onRunAnalyze={onRunAnalyze} />
    );
    expect(screen.queryByText("Run with ANALYZE")).toBeNull();

    const typed = estimatedRun();
    typed.kind = "query";
    typed.slots[0].sql = "EXPLAIN (FORMAT JSON) select 1";
    view.rerender(
      <SqlResultsPane {...base} runs={[typed]} onRunAnalyze={onRunAnalyze} />
    );
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(screen.queryByText("Run with ANALYZE")).toBeNull();

    view.rerender(<SqlResultsPane {...base} runs={[estimatedRun()]} />);
    expect(screen.queryByText("Run with ANALYZE")).toBeNull();

    // An estimate shown because the statement can't be measured.
    const update = estimatedRun();
    update.slots[0].sourceSql = "update t set x = 1";
    view.rerender(
      <SqlResultsPane {...base} runs={[update]} onRunAnalyze={onRunAnalyze} />
    );
    expect(screen.queryByText("Run with ANALYZE")).toBeNull();

    // Older runs without the slot's statement are not re-measured.
    const older = estimatedRun();
    delete older.slots[0].sourceSql;
    view.rerender(
      <SqlResultsPane {...base} runs={[older]} onRunAnalyze={onRunAnalyze} />
    );
    expect(screen.queryByText("Run with ANALYZE")).toBeNull();
  });
});

describe("plan statements on other engines", () => {
  it("opens MariaDB's ANALYZE FORMAT=JSON as a measured plan", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const json = readFileSync(
      resolve(
        __dirname,
        "../../test/fixtures/engine-plans/mariadb11-analyze.json"
      ),
      "utf8"
    );
    const typed = run();
    typed.kind = "query";
    typed.slots[0].sql = "ANALYZE FORMAT=JSON select 1";
    typed.slots[0].result!.columns = [{ name: "ANALYZE", db_type: "text" }];
    typed.slots[0].result!.rows = [[{ t: "Str", v: json }]];
    render(<SqlResultsPane {...base} engine="mariadb" runs={[typed]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(screen.getByText("Measured plan")).toBeInTheDocument();
  });
});

describe("SQL result grids", () => {
  it("are read-only, for direct and streamed results", () => {
    const direct = run();
    direct.kind = "query";
    direct.title = "Query";
    direct.slots[0].sql = "select id from t";
    direct.slots[0].result!.columns = [{ name: "id", db_type: "int" }];
    direct.slots[0].result!.rows = [[1]];
    const view = render(<SqlResultsPane {...base} runs={[direct]} />);
    expect(state.tableProps[state.tableProps.length - 1]).toMatchObject({
      readOnly: true,
    });
    expect(
      state.tableProps[state.tableProps.length - 1]?.onCellChange
    ).toBeUndefined();

    state.streams.s1 = {
      status: "done",
      columns: [{ name: "id", db_type: "int" }],
      totalRows: 2,
      rowsVersion: 1,
      getRowAt: (i: number) => [i],
    };
    const streamed: SqlResultRun = {
      ...direct,
      slots: [
        {
          index: 0,
          sql: "select id from t",
          status: "done",
          mode: "stream",
          opId: "s1",
        },
      ],
    };
    view.rerender(<SqlResultsPane {...base} runs={[streamed]} />);
    expect(state.tableProps[state.tableProps.length - 1]).toMatchObject({
      readOnly: true,
    });
  });
});

describe("SQL result summary", () => {
  function queryRun(
    slot: Partial<SqlResultRun["slots"][number]>
  ): SqlResultRun {
    return {
      id: "a",
      kind: "query",
      title: "Query",
      sql: "x",
      createdAt: 1,
      slots: [{ index: 0, sql: "x", status: "done", ...slot } as any],
    };
  }

  it("says a statement that returns no rows completed, with its time", () => {
    render(
      <SqlResultsPane
        {...base}
        runs={[
          queryRun({
            mode: "direct",
            startedAt: 1000,
            finishedAt: 1035,
            result: { columns: [], rows: [], rowCount: 0 },
          }),
        ]}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Statement completed · 35 ms"
    );
  });

  it("says when a streamed result stopped at the row limit", () => {
    state.streams.big = {
      status: "done",
      ended: true,
      truncated: true,
      elapsedMs: 1500,
      columns: [{ name: "id", db_type: "int" }],
      totalRows: 50000,
      rowsVersion: 1,
      getRowAt: (i: number) => [i],
    };
    render(
      <SqlResultsPane
        {...base}
        runs={[queryRun({ mode: "stream", opId: "big" })]}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "50,000 rows (stopped at the row limit"
    );
    expect(screen.getByRole("status")).toHaveTextContent("1.5 s");
  });

  it("uses the statement's own timing when the backend sent none", () => {
    state.streams.plain = {
      status: "done",
      ended: true,
      columns: [{ name: "id", db_type: "int" }],
      totalRows: 1,
      rowsVersion: 1,
      getRowAt: () => [1],
    };
    render(
      <SqlResultsPane
        {...base}
        runs={[
          queryRun({
            mode: "stream",
            opId: "plain",
            startedAt: 1000,
            finishedAt: 1035,
          }),
        ]}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 row · 35 ms");
  });

  it("shows Running, not No result, while an empty stream's statement runs", () => {
    state.streams.slow = {
      status: "done",
      ended: false,
      columns: [],
      totalRows: 0,
      rowsVersion: 0,
      getRowAt: () => undefined,
    };
    render(
      <SqlResultsPane
        {...base}
        runs={[queryRun({ mode: "stream", opId: "slow", status: "running" })]}
      />
    );
    expect(screen.getByText("Running...")).toBeTruthy();
    expect(screen.queryByText("No result.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("SQL result errors and tabs", () => {
  const errorRun = (id: string, title: string): SqlResultRun => ({
    id,
    kind: "query",
    title,
    sql: "x",
    createdAt: 1,
    slots: [
      {
        index: 0,
        sql: "select bad",
        status: "error",
        error: 'ERROR: column "bad" does not exist',
      } as any,
    ],
  });

  it("copies the error text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<SqlResultsPane {...base} runs={[errorRun("a", "Run 1")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(
      'ERROR: column "bad" does not exist'
    );
    expect(screen.getByRole("button", { name: "Error copied" })).toBeTruthy();
  });

  it("moves between run tabs with the arrow keys and closes with Delete", () => {
    const setActiveRunId = vi.fn();
    const onCloseRun = vi.fn();
    render(
      <SqlResultsPane
        {...base}
        activeRunId="a"
        setActiveRunId={setActiveRunId}
        onCloseRun={onCloseRun}
        runs={[errorRun("a", "Run 1"), errorRun("b", "Run 2")]}
      />
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(setActiveRunId).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(setActiveRunId).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(tabs[0]!, { key: "Delete" });
    expect(onCloseRun).toHaveBeenCalledWith("a");
  });

  it("keeps keyboard focus on the selected tab after closing one", () => {
    function Host() {
      const [runs, setRuns] = useState([
        errorRun("a", "Run 1"),
        errorRun("b", "Run 2"),
        errorRun("c", "Run 3"),
      ]);
      const [active, setActive] = useState("b");
      return (
        <SqlResultsPane
          {...base}
          runs={runs}
          activeRunId={active}
          setActiveRunId={setActive}
          onCloseRun={(id) => {
            const index = runs.findIndex((run) => run.id === id);
            const rest = runs.filter((run) => run.id !== id);
            setRuns(rest);
            if (id === active) {
              setActive((rest[Math.max(0, index - 1)] ?? rest[0])!.id);
            }
          }}
        />
      );
    }
    render(<Host />);
    const middle = screen.getByRole("tab", { name: /Run 2/ });
    middle.focus();
    act(() => {
      fireEvent.keyDown(middle, { key: "Delete" });
    });
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: /Run 1/ })
    );

    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
    });
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: /Run 3/ })
    );
  });

  it("focuses the empty results area after closing the last run", () => {
    function Host() {
      const [runs, setRuns] = useState([errorRun("a", "Run 1")]);
      return (
        <SqlResultsPane
          {...base}
          runs={runs}
          activeRunId={runs[0]?.id ?? null}
          onCloseRun={(id) => setRuns((all) => all.filter((r) => r.id !== id))}
        />
      );
    }
    render(<Host />);
    const tab = screen.getByRole("tab", { name: /Run 1/ });
    tab.focus();
    act(() => {
      fireEvent.keyDown(tab, { key: "Delete" });
    });
    const empty = screen.getByText("Run a query to see results here.")
      .parentElement as HTMLElement;
    expect(document.activeElement).toBe(empty);
  });
});

describe("SQL result tabs per statement", () => {
  const script: SqlResultRun = {
    id: "s",
    kind: "query",
    title: "Query 1",
    sql: "select 1; select 2",
    createdAt: 1,
    slots: [
      {
        index: 0,
        sql: "select 1",
        title: "Query 1",
        status: "done",
        mode: "direct",
        result: {
          columns: [{ name: "a", db_type: "int" }],
          rows: [[1]],
          rowCount: 1,
        },
      } as any,
      {
        index: 1,
        sql: "select 2",
        title: "Query 2",
        status: "done",
        mode: "direct",
        result: {
          columns: [{ name: "b", db_type: "int" }],
          rows: [[2]],
          rowCount: 1,
        },
      } as any,
    ],
  };

  it("shows one row of tabs, one per statement", () => {
    const setActiveRunId = vi.fn();
    const setActiveIndex = vi.fn();
    render(
      <SqlResultsPane
        {...base}
        activeRunId="s"
        setActiveRunId={setActiveRunId}
        setActiveIndex={setActiveIndex}
        runs={[script]}
      />
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "OKQuery 1",
      "OKQuery 2",
    ]);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.queryByText(/Statement 1/)).toBeNull();

    fireEvent.click(tabs[1]!);
    expect(setActiveRunId).toHaveBeenCalledWith("s");
    expect(setActiveIndex).toHaveBeenCalledWith(1);
  });

  it("closes one statement's tab through the slot close", () => {
    const onCloseSlot = vi.fn();
    const onCloseRun = vi.fn();
    render(
      <SqlResultsPane
        {...base}
        activeRunId="s"
        onCloseRun={onCloseRun}
        onCloseSlot={onCloseSlot}
        runs={[script]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Query 2" }));
    expect(onCloseSlot).toHaveBeenCalledWith("s", 1);
    expect(onCloseRun).not.toHaveBeenCalled();
  });
});

describe("statement tab names and focus", () => {
  it("names Compare baselines like their result tabs", () => {
    // Two typed EXPLAIN statements ran as Query 1 and Query 2; Query 1's tab
    // was closed, so its run now holds only Query 2.
    const earlier = run("e");
    earlier.kind = "query";
    earlier.title = "Query 1";
    earlier.slots = [
      {
        ...run().slots[0]!,
        index: 1,
        title: "Query 2",
        sql: "EXPLAIN (FORMAT JSON) select 2",
      },
    ];
    const current = run("c");
    current.title = "Explain 2";
    current.createdAt = 2;
    render(
      <SqlResultsPane {...base} activeRunId="c" runs={[earlier, current]} />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(screen.getByRole("option", { name: "Query 2" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Query 1" })).toBeNull();
  });

  it("focuses the empty area when one tab closes the only running script", () => {
    const running: SqlResultRun = {
      id: "r",
      kind: "query",
      title: "Query 1",
      sql: "select pg_sleep(9); select 2",
      createdAt: 1,
      slots: [
        {
          index: 0,
          sql: "select pg_sleep(9)",
          title: "Query 1",
          status: "running",
        } as any,
        {
          index: 1,
          sql: "select 2",
          title: "Query 2",
          status: "queued",
        } as any,
      ],
    };
    function Host() {
      const [runs, setRuns] = useState([running]);
      // The runner closes a running script as a whole.
      const closeAll = () => setRuns([]);
      return (
        <SqlResultsPane
          {...base}
          runs={runs}
          activeRunId={runs[0]?.id ?? null}
          onCloseRun={closeAll}
          onCloseSlot={closeAll}
        />
      );
    }
    render(<Host />);
    const tab = screen.getByRole("tab", { name: /Query 2/ });
    tab.focus();
    act(() => {
      fireEvent.keyDown(tab, { key: "Backspace" });
    });
    const empty = screen.getByText("Run a query to see results here.")
      .parentElement as HTMLElement;
    expect(document.activeElement).toBe(empty);
  });
});
