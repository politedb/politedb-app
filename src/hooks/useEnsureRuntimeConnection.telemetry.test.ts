import { renderHook, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  connect: vi.fn(),
  track: vi.fn(),
}));

vi.mock("src/lib/runtimeConnection", () => ({
  connectTabOnce: m.connect,
  resolveTabRuntimeConnectionId: () => undefined,
  runtimeServesTab: () => false,
  TAB_CONNECT_SUPERSEDED: "TAB_CONNECT_SUPERSEDED",
}));
vi.mock("src/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/analytics")>()),
  trackEvent: m.track,
}));
vi.mock("src/stores/connectionLog", () => ({
  recordConnectionSessionFailed: vi.fn(),
  recordConnectionSessionOpened: vi.fn(),
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { sanitizeProps } from "src/lib/analytics";
import { useScreenStore } from "src/stores/screen";
import { useEnsureRuntimeConnection } from "./useEnsureRuntimeConnection";

const tab = {
  id: "t",
  profileId: "p1",
  engine: "postgres",
  label: "Athena · secret_db",
  target: { kind: "override", database: "secret_db" },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  useScreenStore.setState({
    profileTabs: [tab],
    activeProfileScreen: "t",
  } as never);
});

describe("reconnect telemetry (R10)", () => {
  it("sends only the allowed fields, and errors as a category", async () => {
    m.connect.mockRejectedValue(
      new Error(
        'RUNTIME_CONNECT_FAILED: database "secret_db" does not exist at /Users/me/secret.sqlite'
      )
    );
    renderHook(() => useEnsureRuntimeConnection(tab));
    await waitFor(() => expect(m.track).toHaveBeenCalled());
    const [event, props] = m.track.mock.calls[0]!;
    expect(event).toBe("runtime_connection_open_error");
    expect(Object.keys(props).sort()).toEqual([
      "duration_ms",
      "engine",
      "error",
      "source",
    ]);
    const sent = JSON.stringify(sanitizeProps(props));
    expect(sent).not.toContain("secret_db");
    expect(sent).not.toContain("secret.sqlite");
    expect(m.connect).toHaveBeenCalledWith("t");
  });

  it("never connects an unknown tab, and sends nothing", async () => {
    const unknown = {
      ...(tab as object),
      target: { kind: "unknown" },
    } as never;
    useScreenStore.setState({ profileTabs: [unknown] } as never);
    renderHook(() => useEnsureRuntimeConnection(unknown));
    await new Promise((r) => setTimeout(r, 0));
    expect(m.connect).not.toHaveBeenCalled();
    expect(m.track).not.toHaveBeenCalled();
  });
});
