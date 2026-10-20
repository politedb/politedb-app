import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/preact";
import { DbHealthInspectorDialog } from "./DbHealthInspectorDialog";
import { useLicenseStore } from "src/stores/license";
import type { LicenseState } from "src/lib/tauri/license";

// Real hook, mocked collector: covers that the dialog never queries without Pro.
const collectMock = vi.fn();

vi.mock("src/lib/tauri/health-inspector", () => ({
  collectHealthInspectorSnapshot: (...args: any[]) => collectMock(...args),
}));

function section(data: unknown) {
  return {
    status: "empty",
    collectedAt: 2,
    error: null,
    truncated: false,
    unavailableReason: null,
    data,
  };
}

function snap() {
  return {
    runtimeConnectionId: "c1",
    profileId: "p1",
    engine: "postgres",
    startedAt: 1,
    finishedAt: 2,
    overallError: null,
    cancelled: false,
    overview: section(null),
    sessions: section([]),
    statements: { ...section([]), info: null },
    tables: section([]),
    indexes: section([]),
  };
}

function setProAccess(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

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

const LOCKED_TEXT = "The database health inspector is a Pro feature.";

beforeEach(() => {
  collectMock.mockReset();
  collectMock.mockResolvedValue(snap());
});

describe("DbHealthInspectorDialog Pro gating", () => {
  it("collects a snapshot when opened with Pro", async () => {
    setProAccess(true);
    renderDialog();
    await waitFor(() => expect(collectMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(LOCKED_TEXT)).toBeNull();
  });

  it("shows the locked state and issues no query without Pro", async () => {
    setProAccess(false);
    renderDialog();
    expect(screen.getByText(LOCKED_TEXT)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(collectMock).not.toHaveBeenCalled();
  });

  it("locks and stops querying when access ends while open", async () => {
    setProAccess(true);
    renderDialog();
    await waitFor(() => expect(collectMock).toHaveBeenCalledTimes(1));

    act(() => setProAccess(false));
    expect(screen.getByText(LOCKED_TEXT)).toBeTruthy();
    expect(screen.queryByTitle("Refresh snapshot")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(collectMock).toHaveBeenCalledTimes(1);
  });
});
