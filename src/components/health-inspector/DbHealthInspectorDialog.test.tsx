import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { DbHealthInspectorDialog } from "./DbHealthInspectorDialog";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import type { LicenseState } from "src/lib/tauri/license";

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

function setProAccess(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

beforeEach(() => {
  setProAccess(true);
  useProUpgradeStore.setState({ feature: null });
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
        idleInTransactionCount: 0,
        idleInTransactionOldestXactAgeSeconds: null,
        idleInTransactionLongestIdleSeconds: null,
        topBlockers: [],
        hasUnresolvedBlockers: false,
        lockWaitDurationAvailable: false,
        tempFiles: 0,
        tempBytes: 0,
        deadlocks: 0,
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
  it("shows a locked state without Pro and opens the upgrade dialog", () => {
    setProAccess(false);
    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );

    expect(
      screen.getByText("The database health inspector is a Pro feature.")
    ).toBeTruthy();
    expect(screen.queryByTitle("Refresh snapshot")).toBeNull();
    expect(screen.queryByText("Overview")).toBeNull();
    fireEvent.click(screen.getByText("Upgrade"));
    expect(useProUpgradeStore.getState().feature).toBe("health-inspector");
    expect(hookState.refresh).not.toHaveBeenCalled();
  });

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

  it("shows overview skeleton and locks other tabs while loading", () => {
    hookState.snapshot = null;
    hookState.loading = true;
    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );

    expect(
      screen.getByRole("status", { name: "Loading overview" })
    ).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();

    const sessionsTab = screen.getByRole("button", { name: "Sessions" });
    expect(sessionsTab).toBeDisabled();
    fireEvent.click(sessionsTab);
    // Still on overview skeleton — table skeleton / Sessions header absent
    expect(screen.queryByRole("status", { name: "Loading table" })).toBeNull();
    expect(screen.queryByText("PID")).toBeNull();
    expect(
      screen.getByRole("status", { name: "Loading overview" })
    ).toBeTruthy();
  });

  it("keeps Cancel available while loading and shows table skeleton on active tab", () => {
    hookState.snapshot = null;
    hookState.loading = true;
    // Start would be overview; switch isn't possible while loading, so seed via
    // re-render after setting loading false briefly is unnecessary — stay overview.
    // Instead verify Cancel enabled, then simulate being on Sessions by toggling
    // loading off, switching, then loading on again.
    const { rerender } = render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );

    const cancelBtn = screen.getByTitle("Cancel in-flight inspector queries");
    expect(cancelBtn).not.toBeDisabled();
    fireEvent.click(cancelBtn);
    expect(hookState.cancel).toHaveBeenCalled();

    // Allow tab switch, go to Sessions, then lock again with loading
    hookState.loading = false;
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
          sessionCount: 1,
          activeSessionCount: 1,
          idleSessionCount: 0,
          blockedSessionCount: 0,
          longestXactAgeSeconds: 1,
          hiddenQueryCount: 0,
          restrictedActivityCount: 0,
          databaseBytes: 1,
          statsReset: null,
          restrictedVisibility: false,
          idleInTransactionCount: 0,
          idleInTransactionOldestXactAgeSeconds: null,
          idleInTransactionLongestIdleSeconds: null,
          topBlockers: [],
          hasUnresolvedBlockers: false,
          lockWaitDurationAvailable: false,
          tempFiles: 0,
          tempBytes: 0,
          deadlocks: 0,
        },
      },
      sessions: {
        status: "ready",
        collectedAt: Date.now(),
        error: null,
        truncated: false,
        unavailableReason: null,
        data: [],
      },
      statements: {
        status: "empty",
        collectedAt: Date.now(),
        error: null,
        truncated: false,
        unavailableReason: null,
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
    rerender(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.getByText("No sessions")).toBeTruthy();

    hookState.loading = true;
    rerender(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    expect(screen.getByRole("status", { name: "Loading table" })).toBeTruthy();
    expect(screen.queryByText("No sessions")).toBeNull();
    expect(screen.getByRole("button", { name: "Overview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sessions" })).not.toBeDisabled();
    expect(
      screen.getByTitle("Cancel in-flight inspector queries")
    ).not.toBeDisabled();
  });

  it("opens Sessions from Attention without refresh", () => {
    hookState.snapshot.overview.data.blockedSessionCount = 1;
    hookState.snapshot.overview.data.topBlockers = [
      {
        pid: 99,
        blockedSessionCount: 1,
        inCurrentDatabase: true,
        isPreparedTransaction: false,
      },
    ];
    hookState.refresh.mockClear();
    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    const buttons = screen.getAllByText("Open Sessions");
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]!);
    expect(hookState.refresh).not.toHaveBeenCalled();
    expect(screen.getByText("PID")).toBeTruthy();
  });
});
