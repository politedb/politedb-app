import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { DbHealthInspectorDialog } from "./DbHealthInspectorDialog";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import type { LicenseState } from "src/lib/tauri/license";

const hookState = {
  snapshot: null as any,
  loading: false,
  refreshing: false,
  lastArgs: null as any,
  error: null as string | null,
  refresh: vi.fn(),
  cancel: vi.fn(),
  clear: vi.fn(),
  supported: true,
};

vi.mock("@root/src/hooks/useDbHealthInspector", () => ({
  useDbHealthInspector: (args: any) => {
    hookState.lastArgs = args;
    return hookState;
  },
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
    server: {
      status: "ready",
      collectedAt: Date.now(),
      error: null,
      truncated: false,
      unavailableReason: null,
      data: {
        maxXidAge: 1_000_000,
        autovacuumFreezeMaxAge: 200_000_000,
        maxConnections: 100,
        reservedConnections: 3,
        clientConnections: 4,
        canReadAllStats: true,
        blocksHit: 99_000,
        blocksRead: 1_000,
        isStandby: false,
        standbyReplayLagSeconds: null,
        replicaCount: 0,
        maxReplicaLagSeconds: null,
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
  hookState.refreshing = false;
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
    fireEvent.click(screen.getByRole("button", { name: /^Sessions/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /^Sessions/ }));

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
    fireEvent.click(screen.getByRole("button", { name: /^Top statements/ }));

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
    fireEvent.click(screen.getByRole("button", { name: /^Top statements/ }));

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
    fireEvent.click(screen.getByRole("button", { name: /^Top statements/ }));

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
    fireEvent.click(screen.getByRole("button", { name: /^Sessions/ }));

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
    fireEvent.click(screen.getByRole("button", { name: /^Tables/ }));

    // Autovacuum newer than manual vacuum for orders.
    const autoVacuumLocal = new Date("2024-06-01T00:00:00.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const expectedVacuum = `${autoVacuumLocal.getFullYear()}-${pad(autoVacuumLocal.getMonth() + 1)}-${pad(autoVacuumLocal.getDate())} ${pad(autoVacuumLocal.getHours())}:${pad(autoVacuumLocal.getMinutes())}:${pad(autoVacuumLocal.getSeconds())}`;
    expect(screen.getAllByText(expectedVacuum).length).toBeGreaterThan(0);

    // Partition leaf labeled and visible with nonzero storage path.
    expect(screen.getByText(/events_2024 \(partition\)/)).toBeTruthy();
  });

  it("shows overview skeleton and lets tabs switch to their own skeleton while loading", () => {
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

    const sessionsTab = screen.getByRole("button", { name: /^Sessions/ });
    expect(sessionsTab).not.toBeDisabled();
    fireEvent.click(sessionsTab);
    expect(screen.getByRole("status", { name: "Loading table" })).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: "Loading overview" })
    ).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: /^Sessions/ }));
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
    // A section that already finished stays visible while the rest load.
    expect(screen.getByText("No sessions")).toBeTruthy();

    hookState.snapshot.sessions.status = "loading";
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
    // Tabs stay switchable while sections are still loading.
    expect(
      screen.getByRole("button", { name: /^Overview/ })
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /^Sessions/ })
    ).not.toBeDisabled();
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

  it("summarizes a clean overview with merged sessions and plain empty values", () => {
    hookState.snapshot.overview.data.longestXactAgeSeconds = null;
    render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    expect(screen.getByText("✓ All clear in this snapshot")).toBeTruthy();
    expect(screen.getByText("3 sessions")).toBeTruthy();
    expect(screen.getByText("2 idle · 1 active")).toBeTruthy();
    expect(screen.getByText("None running")).toBeTruthy();
    // Temp files, deadlocks and replication.
    expect(screen.getAllByText("None").length).toBe(3);
    expect(screen.queryByText(/0\.0 B/)).toBeNull();
    // The Inspector-connection caveat lives in one hint, not on every card.
    expect(screen.queryByText(/Excludes this Inspector connection/)).toBeNull();
    const hints = screen.getAllByRole("img", { name: "More info" });
    expect(
      hints.some((hint) =>
        /exclude this Inspector connection/.test(
          document.getElementById(hint.getAttribute("aria-describedby")!)
            ?.textContent ?? ""
        )
      )
    ).toBe(true);
  });

  it("counts issues in the summary strip and colors their cards", () => {
    const data = hookState.snapshot.overview.data;
    data.blockedSessionCount = 2;
    data.idleInTransactionCount = 1;
    data.idleInTransactionOldestXactAgeSeconds = 30;
    data.idleInTransactionLongestIdleSeconds = 20;
    const { container } = render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    expect(screen.getByText("⚠ 2 issues")).toBeTruthy();
    expect(container.querySelectorAll('[data-tone="critical"]').length).toBe(1);
    expect(container.querySelectorAll('[data-tone="warning"]').length).toBe(1);
  });

  it("shows the snapshot age and duration, and swaps Refresh for Cancel while loading", () => {
    const finishedAt = Date.now() - 2 * 60_000;
    hookState.snapshot.startedAt = finishedAt - 1_200;
    hookState.snapshot.finishedAt = finishedAt;
    const { rerender } = render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    expect(
      screen.getByText(/2 min ago \(\d\d:\d\d\) · collected in 1\.2 s/)
    ).toBeTruthy();
    expect(screen.getByTitle("Refresh snapshot")).toBeTruthy();
    expect(
      screen.queryByTitle("Cancel in-flight inspector queries")
    ).toBeNull();

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
    expect(screen.getByText(/Collecting…/)).toBeTruthy();
    expect(screen.queryByTitle("Refresh snapshot")).toBeNull();
    expect(
      screen.getByTitle("Cancel in-flight inspector queries")
    ).toBeTruthy();
  });

  it("never shows All clear when the overview failed", () => {
    hookState.snapshot.overview = {
      ...hookState.snapshot.overview,
      status: "error",
      error: "canceling statement due to statement timeout",
      data: null,
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
    expect(screen.getByText(/statement timeout/)).toBeTruthy();
    expect(screen.queryByText(/All clear/)).toBeNull();
  });

  it("flags an estimated size ranking on large databases", () => {
    hookState.snapshot.tables = {
      ...hookState.snapshot.tables,
      status: "ready",
      sizeRankingEstimated: true,
      data: [
        {
          schema: "public",
          tableName: "events",
          liveTuples: 1,
          deadTuples: 0,
          lastVacuum: null,
          lastAutovacuum: null,
          lastAnalyze: null,
          lastAutoAnalyze: null,
          tableBytes: 1,
          indexesBytes: 0,
          totalBytes: 1,
          isPartitionedParent: false,
          isPartitionChild: false,
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
    fireEvent.click(screen.getByRole("button", { name: /^Tables/ }));
    expect(screen.getByText(/recently grown one may be missing/)).toBeTruthy();
  });

  function renderDialog() {
    return render(
      <DbHealthInspectorDialog
        open
        onClose={() => {}}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
  }

  function tableRow(name: string, live: number, dead: number) {
    return {
      schema: "public",
      tableName: name,
      liveTuples: live,
      deadTuples: dead,
      lastVacuum: null,
      lastAutovacuum: null,
      lastAnalyze: null,
      lastAutoAnalyze: null,
      tableBytes: 1,
      indexesBytes: 0,
      totalBytes: live,
      isPartitionedParent: false,
      isPartitionChild: false,
    };
  }

  it("searches, flags and sorts tables, offering VACUUM only where needed", () => {
    hookState.snapshot.tables = {
      ...hookState.snapshot.tables,
      status: "ready",
      sizeRankingEstimated: false,
      data: [
        tableRow("orders", 10_000, 100),
        tableRow("events", 4_000, 6_000),
        tableRow("audit_log", 50_000, 0),
      ],
    };
    renderDialog();
    const tablesTab = screen.getByRole("button", { name: /^Tables/ });
    expect(tablesTab.textContent).toContain("3");
    expect(tablesTab.textContent).toContain("1 to vacuum");
    fireEvent.click(tablesTab);

    expect(screen.getAllByRole("button", { name: "Copy VACUUM" })).toHaveLength(
      1
    );

    fireEvent.input(screen.getByRole("searchbox", { name: "Search tables" }), {
      target: { value: "ORD" },
    });
    expect(screen.getByText("public.orders")).toBeTruthy();
    expect(screen.queryByText("public.events")).toBeNull();
    expect(screen.getByText("1 of 3")).toBeTruthy();

    fireEvent.input(screen.getByRole("searchbox", { name: "Search tables" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Needs vacuum (1)" }));
    expect(screen.getByText("public.events")).toBeTruthy();
    expect(screen.queryByText("public.orders")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Needs vacuum (1)" }));

    // Sort by dead rows: descending first.
    // Table sorts on mouse-up of the header button.
    fireEvent.mouseUp(screen.getByText("Dead (est.)"), { button: 0 });
    const names = screen.getAllByText(/^public\./).map((el) => el.textContent);
    expect(names).toEqual([
      "public.events",
      "public.orders",
      "public.audit_log",
    ]);
  });

  it("offers DROP INDEX only for unused, non-unique indexes", () => {
    const index = (name: string, scans: number | null, unique: boolean) => ({
      schema: "public",
      tableName: "events",
      indexName: name,
      idxScan: scans,
      idxTupRead: 0,
      idxTupFetch: 0,
      indexBytes: 8192,
      isUnique: unique,
      enforcesConstraint: unique,
    });
    hookState.snapshot.indexes = {
      ...hookState.snapshot.indexes,
      status: "ready",
      sizeRankingEstimated: false,
      data: [
        index("events_kind_idx", 0, false),
        index("events_pkey", 0, true),
        index("events_at_idx", 12, false),
      ],
    };
    renderDialog();
    const indexesTab = screen.getByRole("button", { name: /^Indexes/ });
    expect(indexesTab.textContent).toContain("1 unused");
    fireEvent.click(indexesTab);
    const copy = screen.getAllByRole("button", { name: "Copy DROP" });
    expect(copy).toHaveLength(1);
    expect(copy[0]!.getAttribute("title")).toBe(
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."events_kind_idx";'
    );
  });

  it("clears the search on Escape without closing the dialog", () => {
    const onClose = vi.fn();
    render(
      <DbHealthInspectorDialog
        open
        onClose={onClose}
        engine="postgres"
        runtimeConnectionId="c1"
        profileId="p1"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Sessions/ }));
    const search = screen.getByRole("searchbox", {
      name: "Search PID, user, app, query",
    });
    fireEvent.input(search, { target: { value: "nothing-matches" } });
    expect(screen.getByText("No matching rows")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows server health cards and waits for them before All clear", () => {
    const { rerender } = renderDialog();
    expect(screen.getByText("4 / 100")).toBeTruthy();
    expect(screen.getByText("99.0%")).toBeTruthy();
    expect(screen.getByText("1M")).toBeTruthy();
    expect(screen.getByText("✓ All clear in this snapshot")).toBeTruthy();

    hookState.loading = true;
    hookState.snapshot.server = {
      ...hookState.snapshot.server,
      status: "loading",
      data: null,
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
    expect(screen.getByText("Checking server health…")).toBeTruthy();
    expect(screen.queryByText(/All clear/)).toBeNull();
  });

  it("passes the auto-refresh choice to the hook, off by default", () => {
    renderDialog();
    expect(hookState.lastArgs.autoRefreshMs).toBeNull();
    const select = screen.getByRole("combobox", { name: /Auto-refresh/ });
    fireEvent.input(select, { target: { value: "10000" } });
    expect(hookState.lastArgs.autoRefreshMs).toBe(10_000);
    fireEvent.input(select, { target: { value: "off" } });
    expect(hookState.lastArgs.autoRefreshMs).toBeNull();
  });

  it("does not claim All clear when server checks failed", () => {
    hookState.snapshot.server = {
      ...hookState.snapshot.server,
      status: "error",
      error: "canceling statement due to statement timeout",
      data: null,
    };
    renderDialog();
    expect(
      screen.getByText("No issues found, but server checks are incomplete")
    ).toBeTruthy();
    expect(screen.queryByText(/All clear/)).toBeNull();
  });

  it("does not grade connections the role cannot fully see", () => {
    hookState.snapshot.server.data = {
      ...hookState.snapshot.server.data,
      canReadAllStats: false,
      clientConnections: null,
    };
    renderDialog();
    expect(screen.getByText("Needs pg_read_all_stats")).toBeTruthy();
    expect(
      screen.getByText("No issues found, but server checks are incomplete")
    ).toBeTruthy();
  });
});
