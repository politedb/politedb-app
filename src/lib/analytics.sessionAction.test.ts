import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js", () => ({
  default: new Proxy(
    { capture },
    {
      // init, register, opt_in_capturing, ... are no-ops in these tests.
      get: (target, key) =>
        key in target ? (target as any)[key] : () => undefined,
    }
  ),
}));

import {
  sanitizeProps,
  sessionActionEventProps,
  trackHealthInspectorSessionAction,
} from "./analytics";

const CONSENT_KEY = "politedb.analytics.consent";

describe("sessionActionEventProps", () => {
  it("builds exactly { kind, outcome } from known values", () => {
    expect(sessionActionEventProps("terminate", "denied")).toEqual({
      kind: "terminate",
      outcome: "denied",
    });
  });

  it("drops anything outside the closed sets", () => {
    for (const [kind, outcome] of [
      ["kill", "signalled"],
      ["cancel", "done"],
      ["cancel", { pid: 4242 }],
      [{ kind: "cancel" }, "signalled"],
      ["cancel", "permission denied for user app"],
    ]) {
      expect(sessionActionEventProps(kind, outcome)).toBeNull();
    }
  });
});

describe("trackHealthInspectorSessionAction", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ANALYTICS_ENABLED", "true");
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
    capture.mockClear();
    localStorage.removeItem(CONSENT_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.removeItem(CONSENT_KEY);
  });

  function captured() {
    return capture.mock.calls.filter(
      ([event]) => event === "health_inspector_session_action"
    );
  }

  it.each(["signalled", "denied", "unknown", "busy"])(
    "sends only kind and outcome (%s) with consent",
    (outcome) => {
      localStorage.setItem(CONSENT_KEY, "granted");
      trackHealthInspectorSessionAction("terminate", outcome);
      expect(captured()).toHaveLength(1);
      const [, props] = captured()[0]!;
      const expected = sanitizeProps({ kind: "terminate", outcome });
      expect(props).toEqual(expected);
      // Nothing beyond the two custom properties and the shared app context.
      const custom = Object.keys(props).filter(
        (key) => !(key in (sanitizeProps({}) ?? {}))
      );
      expect(custom.sort()).toEqual(["kind", "outcome"]);
      expect(JSON.stringify(props)).not.toMatch(/4242|PoliteDB\/|pg_/);
    }
  );

  it.each(["denied", "unknown", null])(
    "sends nothing when consent is %s",
    (consent) => {
      if (consent) localStorage.setItem(CONSENT_KEY, consent);
      trackHealthInspectorSessionAction("cancel", "signalled");
      expect(captured()).toHaveLength(0);
    }
  );

  it("sends nothing for malformed values even with consent", () => {
    localStorage.setItem(CONSENT_KEY, "granted");
    trackHealthInspectorSessionAction("cancel", {
      outcome: "signalled",
      pid: 4242,
    });
    trackHealthInspectorSessionAction("drop", "signalled");
    expect(captured()).toHaveLength(0);
  });
});
