import { render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlResultRun } from "src/lib/tauri";
import type { LicenseState } from "src/lib/tauri/license";
import { useLicenseStore } from "src/stores/license";
import { queryPlanFixture } from "src/test/fixtures/queryPlan";

const state = vi.hoisted(() => ({
  streams: {} as Record<string, unknown>,
  parse: vi.fn(),
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
vi.mock("src/lib/query-analyzer/fromResult", async (importActual) => {
  const actual =
    await importActual<typeof import("src/lib/query-analyzer/fromResult")>();
  return {
    ...actual,
    planFromResult: (...args: Parameters<typeof actual.planFromResult>) => {
      state.parse();
      return actual.planFromResult(...args);
    },
  };
});
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

import { SqlResultsPane } from "./SqlResultsPane";

const PLAN = JSON.stringify(queryPlanFixture);
const base = {
  engine: "postgres" as const,
  windowId: "w",
  setActiveRunId: vi.fn(),
  activeIndex: 0,
  setActiveIndex: vi.fn(),
  onCloseRun: vi.fn(),
};

function directRun(id: string): SqlResultRun {
  return {
    id,
    kind: "explain",
    title: id,
    sql: "select 1",
    createdAt: 1,
    slots: [
      {
        index: 0,
        sql: "EXPLAIN (FORMAT JSON) select 1",
        status: "done",
        mode: "direct",
        result: {
          columns: [{ name: "QUERY PLAN", db_type: "json" }],
          rows: [[{ t: "Json", v: PLAN }]],
          rowCount: 1,
        },
      },
    ],
  };
}

beforeEach(() => {
  state.streams = {};
  state.parse.mockClear();
  useLicenseStore.setState({
    state: { pro_access: true } as LicenseState,
  });
});

describe("SqlResultsPane plan cache", () => {
  it("parses a finished plan once across result tab switches", () => {
    const a = directRun("a");
    const b = directRun("b");
    const view = render(
      <SqlResultsPane {...base} activeRunId="a" runs={[a, b]} />
    );
    view.rerender(<SqlResultsPane {...base} activeRunId="b" runs={[a, b]} />);
    view.rerender(<SqlResultsPane {...base} activeRunId="a" runs={[a, b]} />);
    view.rerender(<SqlResultsPane {...base} activeRunId="b" runs={[a, b]} />);
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
    expect(state.parse).toHaveBeenCalledTimes(2);
  });

  it("parses again when columns change without a new row count", () => {
    const run: SqlResultRun = {
      ...directRun("v"),
      slots: [
        {
          index: 0,
          sql: "EXPLAIN (FORMAT JSON) select 1",
          status: "done",
          mode: "stream",
          opId: "op-cols",
        },
      ],
    };
    const row = () => [{ t: "Json", v: PLAN }];
    state.streams["op-cols"] = {
      status: "done",
      columns: [],
      totalRows: 1,
      rowsVersion: 1,
      getRowAt: () => undefined,
    };
    const view = render(
      <SqlResultsPane {...base} activeRunId="v" runs={[run]} />
    );
    expect(screen.queryByText("Query Analyzer")).toBeNull();
    state.streams["op-cols"] = {
      status: "done",
      columns: [{ name: "QUERY PLAN" }],
      totalRows: 1,
      rowsVersion: 2,
      getRowAt: row,
    };
    view.rerender(
      <SqlResultsPane {...base} activeRunId="v" runs={[{ ...run }]} />
    );
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
  });

  it("parses a stream again when rows arrive after an early done", () => {
    const run: SqlResultRun = {
      ...directRun("s"),
      slots: [
        {
          index: 0,
          sql: "EXPLAIN (FORMAT JSON) select 1",
          status: "done",
          mode: "stream",
          opId: "op-late",
        },
      ],
    };
    // The idle failsafe marked it done before any row came.
    state.streams["op-late"] = {
      status: "done",
      columns: [],
      totalRows: 0,
      rowsVersion: 1,
      getRowAt: () => undefined,
    };
    const view = render(
      <SqlResultsPane {...base} activeRunId="s" runs={[run]} />
    );
    expect(screen.queryByText("Query Analyzer")).toBeNull();

    state.streams["op-late"] = {
      status: "done",
      columns: [{ name: "QUERY PLAN" }],
      totalRows: 1,
      rowsVersion: 2,
      getRowAt: () => [{ t: "Json", v: PLAN }],
    };
    view.rerender(
      <SqlResultsPane {...base} activeRunId="s" runs={[{ ...run }]} />
    );
    expect(screen.getByText("Query Analyzer")).toBeInTheDocument();
  });
});
