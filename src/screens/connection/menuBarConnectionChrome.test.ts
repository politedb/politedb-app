import { describe, expect, it } from "vitest";
import { resolveMenuBarConnectionChrome } from "./menuBarConnectionChrome";

describe("resolveMenuBarConnectionChrome", () => {
  it("keeps normal (non-error) chrome when connected even if a table load failed", () => {
    expect(
      resolveMenuBarConnectionChrome({
        hasRuntimeConnection: true,
        loadError: 'relation "missing" does not exist',
      })
    ).toEqual({ connected: true, isConnectionError: false });
  });

  it("marks connection-error chrome only when the runtime is down and an error exists", () => {
    expect(
      resolveMenuBarConnectionChrome({
        hasRuntimeConnection: false,
        loadError: "connection refused",
      })
    ).toEqual({ connected: false, isConnectionError: true });
  });

  it("stays idle/normal when disconnected with no error (loading or empty)", () => {
    expect(
      resolveMenuBarConnectionChrome({
        hasRuntimeConnection: false,
        loadError: null,
      })
    ).toEqual({ connected: false, isConnectionError: false });
  });
});
