import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { DbHealthInspectorDialog } from "./DbHealthInspectorDialog";

const hookState = {
  snapshot: null as any,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  cancel: vi.fn(),
  clear: vi.fn(),
  supported: true,
};

vi.mock("@root/src/hooks/useDbHealthInspector", () => ({
  useDbHealthInspector: () => hookState,
}));

beforeEach(() => {
  hookState.snapshot = {
    runtimeConnectionId: "c1",
    profileId: "p1",
    engine: "postgres",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    overallError: null,
    cancelled: false,
    overview: {
      status: "ready",
      collectedAt: Date.now(),
      error: null,
      truncated: false,
      unavailableReason: null,
      data: {
        databaseName: "app",
        sessionCount: 3,
        activeSessionCount: 1,
        idleSessionCount: 2,
        blockedSessionCount: 0,
        longestXactAgeSeconds: 12,
        hiddenQueryCount: 0,
        restrictedActivityCount: 0,
        databaseBytes: 2048,
        statsReset: null,
        restrictedVisibility: false,
      },
    },
    sessions: {
      status: "ready",
      collectedAt: Date.now(),
      error: null,
      truncated: false,
      unavailableReason: null,
      data: [
        {
          pid: 1,
          usename: "u",
          applicationName: "a",
          clientAddr: null,
          state: "active",
          waitEventType: null,
          waitEvent: null,
          backendType: "client backend",
          xactAgeSeconds: 1,
          queryAgeSeconds: 1,
          stateAgeSeconds: 1,
          isExecuting: true,
          queryText: "<script>alert(1)</script>",
          queryHidden: false,
          isBlocked: false,
          blockerPids: [],
        },
      ],
    },
    statements: {
      status: "unavailable",
      collectedAt: Date.now(),
      error: null,
      truncated: false,
      unavailableReason: "pg_stat_statements extension is not installed",
      data: [],
      info: null,
    },
    tables: {
      status: "empty",
      collectedAt: Date.now(),
      error: null,
      truncated: false,
      unavailableReason: null,
      data: [],
    },
    indexes: {
      status: "empty",
      collectedAt: Date.now(),
      error: null,
      truncated: false,
      unavailableReason: null,
      data: [],
    },
  };
  hookState.loading = false;
  hookState.error = null;
  hookState.supported = true;
  hookState.refresh.mockReset();
  hookState.cancel.mockReset();
});

describe("DbHealthInspectorDialog", () => {
  it("renders overview and supports refresh/cancel/close", () => {
    const onClose = vi.fn();
    render(
      <DbHealthInspectorDialog
        open
        onClose={onClose}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
        databaseLabel="app"
      />
    );

    expect(screen.getByText("Database Health Inspector")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Refresh snapshot"));
    expect(hookState.refresh).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Close"));
    expect(hookState.cancel).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows unsupported engine messaging", () => {
    hookState.supported = false;
    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="mysql"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    expect(screen.getByText(/supports PostgreSQL only/i)).toBeTruthy();
  });

  it("renders query text as escaped text, not HTML", () => {
    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const cell = screen.getByText("<script>alert(1)</script>");
    expect(cell.querySelector("script")).toBeNull();
  });

  it("copies the full session query and shows a copied state", async () => {
    const fullQuery = "SELECT * FROM accounts WHERE email = 'long@example.com'";
    hookState.snapshot.sessions.data[0].queryText = fullQuery;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));

    fireEvent.click(screen.getByRole("button", { name: "Copy query" }));
    expect(writeText).toHaveBeenCalledWith(fullQuery);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("shows pg_stat_statements setup guidance only for the missing extension", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Top statements" }));

    expect(screen.getByText(/Unavailable/i)).toBeTruthy();
    expect(screen.getByText("Enable Top statements")).toBeTruthy();
    expect(
      screen.getByText("CREATE EXTENSION IF NOT EXISTS pg_stat_statements;")
    ).toBeTruthy();
    expect(screen.getByText(/PoliteDB is read-only/i)).toBeTruthy();
    expect(screen.getByText(/shared_preload_libraries/i)).toBeTruthy();
    expect(screen.queryByText("Load pg_stat_statements")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy extension SQL" }));
    expect(writeText).toHaveBeenCalledWith(
      "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("shows preload-specific guidance when shared_preload_libraries is required", async () => {
    hookState.snapshot.statements.unavailableReason =
      "pg_stat_statements must be loaded via shared_preload_libraries";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Top statements" }));

    expect(screen.getByText(/Unavailable/i)).toBeTruthy();
    expect(screen.getByText("Load pg_stat_statements")).toBeTruthy();
    expect(screen.queryByText("Enable Top statements")).toBeNull();
    expect(screen.getByText(/will not change server config/i)).toBeTruthy();
    expect(
      screen.getByText("shared_preload_libraries = 'pg_stat_statements'")
    ).toBeTruthy();
    expect(screen.getByText(/Restart Postgres/i)).toBeTruthy();
    expect(screen.getByText(/click Refresh in Health Inspector/i)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Copy preload config" })
    );
    expect(writeText).toHaveBeenCalledWith(
      "shared_preload_libraries = 'pg_stat_statements'"
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("keeps the simpler unavailable state for other statement reasons", () => {
    hookState.snapshot.statements.unavailableReason =
      "permission denied for pg_stat_statements";
    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Top statements" }));

    expect(screen.getByText(/Unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/PoliteDB is read-only/i)).toBeNull();
    expect(screen.queryByText("Enable Top statements")).toBeNull();
    expect(screen.queryByText("Load pg_stat_statements")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy extension SQL" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy preload config" })
    ).toBeNull();
  });

  it("constrains Sessions table in a min-h-0 flex scroller host (Table owns OverlayScroll)", () => {
    hookState.snapshot.sessions.data = Array.from({ length: 40 }, (_, i) => ({
      ...hookState.snapshot.sessions.data[0],
      pid: i + 1,
      queryText: `SELECT ${i}`,
    }));
    hookState.snapshot.sessions.status = "ready";

    const { container } = render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toMatch(/overflow-hidden/);
    expect(dialog.className).toMatch(/h-\[80vh\]/);

    // Tabs content must be a flex column so section flex-1/min-h-0 can bind height.
    const tabsContent = container.querySelector(".mt-2.flex.min-h-0.flex-col");
    expect(tabsContent).toBeTruthy();

    // Table host clips and fills remaining height; Table itself scrolls with OverlayScrollbars.
    const tableHost = container.querySelector(
      ".min-h-0.flex-1.overflow-hidden"
    );
    expect(tableHost).toBeTruthy();
    expect(tableHost?.querySelector("table")).toBeTruthy();
    expect(
      tableHost?.querySelector(".no-scrollbar.h-full.overflow-auto")
    ).toBeTruthy();
  });

  it("prefers the latest vacuum/analyze timestamp across manual/automatic", () => {
    hookState.snapshot.tables = {
      status: "ready",
      collectedAt: Date.now(),
      error: null,
      truncated: false,
      unavailableReason: null,
      data: [
        {
          schema: "public",
          tableName: "orders",
          liveTuples: 10,
          deadTuples: 1,
          lastVacuum: "2024-01-01T00:00:00.000Z",
          lastAutovacuum: "2024-06-01T00:00:00.000Z",
          lastAnalyze: "2024-06-01T00:00:00.000Z",
          lastAutoAnalyze: "2024-01-01T00:00:00.000Z",
          tableBytes: 100,
          indexesBytes: 10,
          totalBytes: 110,
          isPartitionedParent: false,
          isPartitionChild: false,
        },
        {
          schema: "public",
          tableName: "events_2024",
          liveTuples: 100,
          deadTuples: 5,
          lastVacuum: null,
          lastAutovacuum: "2024-05-01T00:00:00.000Z",
          lastAnalyze: null,
          lastAutoAnalyze: "2024-05-02T00:00:00.000Z",
          tableBytes: 1_000_000,
          indexesBytes: 1000,
          totalBytes: 1_001_000,
          isPartitionedParent: false,
          isPartitionChild: true,
        },
      ],
    };

    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Tables" }));

    // Autovacuum newer than manual vacuum for orders.
    const autoVacuumLocal = new Date("2024-06-01T00:00:00.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const expectedVacuum = `${autoVacuumLocal.getFullYear()}-${pad(autoVacuumLocal.getMonth() + 1)}-${pad(autoVacuumLocal.getDate())} ${pad(autoVacuumLocal.getHours())}:${pad(autoVacuumLocal.getMinutes())}:${pad(autoVacuumLocal.getSeconds())}`;
    expect(screen.getAllByText(expectedVacuum).length).toBeGreaterThan(0);

    // Partition leaf labeled and visible with nonzero storage path.
    expect(screen.getByText(/events_2024 \(partition\)/)).toBeTruthy();
  });
});
