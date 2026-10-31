import { act, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StandaloneExportTarget } from "../export/standalone-export/types";
import { useStandaloneTableExport } from "./useStandaloneTableExport";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";

const loadStandaloneExportMetadata = vi.fn();
const selectTable = vi.fn();
const addLogQuery = vi.fn();
const getConnectionState = vi.fn(() => ({
  queryHistory: [],
  selectedTable: null,
  tableDataMap: {},
  columnsCache: {},
  addLogQuery,
}));

vi.mock("../export/standalone-export/loadStandaloneExportMetadata", () => ({
  loadStandaloneExportMetadata: (...args: unknown[]) =>
    loadStandaloneExportMetadata(...args),
  sanitizeStandaloneExportError: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("src/stores/connection", () => ({
  useConnectionStore: {
    getState: () => getConnectionState(),
  },
}));

function target(
  overrides: Partial<StandaloneExportTarget> &
    Pick<StandaloneExportTarget, "requestId" | "tableName">
): StandaloneExportTarget {
  return {
    connectionId: "conn-1",
    engine: "postgres",
    schema: "public",
    ...overrides,
  };
}

type HarnessProps = {
  profileScreenId?: string;
  runtimeConnectionId?: string | undefined;
  engine?: "postgres" | undefined;
  target: StandaloneExportTarget | null;
  onClearTarget: () => void;
};

function Harness(props: HarnessProps) {
  const { phase, close, retry } = useStandaloneTableExport({
    profileScreenId: props.profileScreenId ?? "screen-1",
    runtimeConnectionId: props.runtimeConnectionId,
    engine: props.engine ?? "postgres",
    target: props.target,
    onClearTarget: props.onClearTarget,
  });

  return (
    <div>
      <div data-testid="status">{phase.status}</div>
      <div data-testid="table">
        {"target" in phase ? phase.target.tableName : ""}
      </div>
      <div data-testid="request">
        {"target" in phase ? phase.target.requestId : ""}
      </div>
      <div data-testid="error">
        {phase.status === "error" ? phase.message : ""}
      </div>
      <button type="button" data-testid="close" onClick={close}>
        close
      </button>
      <button type="button" data-testid="retry" onClick={retry}>
        retry
      </button>
    </div>
  );
}

describe("useStandaloneTableExport lifecycle", () => {
  beforeEach(() => {
    loadStandaloneExportMetadata.mockReset();
    resetTabRuntimes();
    seedTabRuntime({ tabId: "screen-1", runtimeId: "conn-1" });
    seedTabRuntime({ tabId: "screen-1b", runtimeId: "conn-2" });
    selectTable.mockReset();
    addLogQuery.mockReset();
    getConnectionState.mockClear();
  });

  it("ignores late metadata for table A after switching target to B", async () => {
    let resolveA:
      | ((value: {
          columns: { name: string; db_type: string }[];
          constraints: null;
        }) => void)
      | undefined;
    let resolveB:
      | ((value: {
          columns: { name: string; db_type: string }[];
          constraints: null;
        }) => void)
      | undefined;

    loadStandaloneExportMetadata
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = resolve;
          })
      );

    const onClearTarget = vi.fn();
    const targetA = target({ requestId: "req-a", tableName: "table_a" });
    const targetB = target({ requestId: "req-b", tableName: "table_b" });

    const { rerender } = render(
      <Harness
        runtimeConnectionId="conn-1"
        target={targetA}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("loading")
    );
    expect(screen.getByTestId("table").textContent).toBe("table_a");
    expect(loadStandaloneExportMetadata).toHaveBeenCalledTimes(1);

    rerender(
      <Harness
        runtimeConnectionId="conn-1"
        target={targetB}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(loadStandaloneExportMetadata).toHaveBeenCalledTimes(2)
    );
    expect(screen.getByTestId("status").textContent).toBe("loading");
    expect(screen.getByTestId("table").textContent).toBe("table_b");

    await act(async () => {
      resolveA?.({
        columns: [{ name: "a_col", db_type: "int" }],
        constraints: null,
      });
    });

    // Stale A must not configure ready/export for A.
    expect(screen.getByTestId("status").textContent).toBe("loading");
    expect(screen.getByTestId("table").textContent).toBe("table_b");
    expect(screen.getByTestId("request").textContent).toBe("req-b");

    await act(async () => {
      resolveB?.({
        columns: [{ name: "b_col", db_type: "text" }],
        constraints: null,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready")
    );
    expect(screen.getByTestId("table").textContent).toBe("table_b");
    expect(screen.getByTestId("request").textContent).toBe("req-b");
    expect(onClearTarget).not.toHaveBeenCalled();
  });

  it("ignores late metadata after cancel clears the target", async () => {
    let resolveA:
      | ((value: {
          columns: { name: string; db_type: string }[];
          constraints: null;
        }) => void)
      | undefined;
    loadStandaloneExportMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        })
    );

    const onClearTarget = vi.fn();
    const targetA = target({ requestId: "req-a", tableName: "table_a" });

    const { rerender } = render(
      <Harness
        runtimeConnectionId="conn-1"
        target={targetA}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("loading")
    );

    await act(async () => {
      screen.getByTestId("close").click();
    });
    expect(onClearTarget).toHaveBeenCalledTimes(1);

    // Parent clears target after close.
    rerender(
      <Harness
        runtimeConnectionId="conn-1"
        target={null}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("idle")
    );

    await act(async () => {
      resolveA?.({
        columns: [{ name: "a_col", db_type: "int" }],
        constraints: null,
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("idle");
    expect(screen.getByTestId("table").textContent).toBe("");
  });

  it("returns to idle and clears target when runtimeConnectionId disconnects while loading", async () => {
    loadStandaloneExportMetadata.mockImplementation(
      () => new Promise(() => {})
    );
    const onClearTarget = vi.fn();
    const targetA = target({ requestId: "req-a", tableName: "table_a" });

    const { rerender } = render(
      <Harness
        runtimeConnectionId="conn-1"
        target={targetA}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("loading")
    );

    rerender(
      <Harness
        runtimeConnectionId={undefined}
        target={targetA}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("idle")
    );
    expect(onClearTarget).toHaveBeenCalled();
  });

  it("returns to idle and clears target when connection id changes while ready", async () => {
    loadStandaloneExportMetadata.mockResolvedValue({
      columns: [{ name: "id", db_type: "int" }],
      constraints: null,
    });
    const onClearTarget = vi.fn();
    const targetA = target({ requestId: "req-a", tableName: "table_a" });

    const { rerender } = render(
      <Harness
        runtimeConnectionId="conn-1"
        target={targetA}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready")
    );

    rerender(
      <Harness
        runtimeConnectionId="conn-other"
        target={targetA}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("idle")
    );
    expect(onClearTarget).toHaveBeenCalled();
  });

  it("cancels in-flight metadata on unmount so late resolve does not leave ready for A", async () => {
    let resolveA:
      | ((value: {
          columns: { name: string; db_type: string }[];
          constraints: null;
        }) => void)
      | undefined;
    loadStandaloneExportMetadata.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        })
    );

    const onClearTarget = vi.fn();
    const targetA = target({ requestId: "req-a", tableName: "table_a" });

    const view = render(
      <Harness
        runtimeConnectionId="conn-1"
        target={targetA}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("loading")
    );

    view.unmount();

    await act(async () => {
      resolveA?.({
        columns: [{ name: "a_col", db_type: "int" }],
        constraints: null,
      });
    });

    // Cancelled path: no throw from setState-after-unmount; session never becomes ready.
    expect(onClearTarget).not.toHaveBeenCalled();
    expect(document.body.textContent ?? "").not.toContain("table_a");
  });

  it("does not touch connection-store tab selection or query history while loading metadata", async () => {
    // Invariant under test: with loadStandaloneExportMetadata mocked, the hook
    // orchestrator never reads/writes useConnectionStore and never calls
    // selectTable / addLogQuery. Active-tab patches, selection, and query
    // history therefore cannot be mutated by this lifecycle path.
    loadStandaloneExportMetadata.mockResolvedValue({
      columns: [{ name: "id", db_type: "int" }],
      constraints: null,
    });
    const onClearTarget = vi.fn();
    const targetA = target({
      requestId: "req-a",
      tableName: "table_a",
      estimatedRow: 27,
    });

    render(
      <Harness
        runtimeConnectionId="conn-1"
        target={targetA}
        onClearTarget={onClearTarget}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("ready")
    );

    expect(selectTable).not.toHaveBeenCalled();
    expect(addLogQuery).not.toHaveBeenCalled();
    expect(getConnectionState).not.toHaveBeenCalled();
    expect(loadStandaloneExportMetadata).toHaveBeenCalledTimes(1);
    expect(loadStandaloneExportMetadata.mock.calls[0]?.[0]).toMatchObject({
      profileScreenId: "screen-1",
      connectionId: "conn-1",
      schema: "public",
      tableName: "table_a",
      estimatedRow: 27,
    });
  });
});
