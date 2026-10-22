import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sanitizeDialogText,
  sessionActionConfirmation,
  sessionActionEligibility,
  sessionActionOutcomeMessage,
} from "./sessionActions";
import { decodeBackendToken } from "./decode";
import {
  HEALTH_INSPECTOR_BACKEND_TOKEN_SQL,
  healthInspectorSessionsSql,
} from "src/lib/queries/sql/health-inspector";
import { SESSION_ACTION_OUTCOMES } from "src/lib/tauri/health-inspector-actions";
import type { HealthSessionRow } from "./types";

const APP = "PoliteDB/abcd1234";
const TOKEN = "2026-10-22T03:04:05.123456Z";

function row(overrides: Partial<HealthSessionRow> = {}): HealthSessionRow {
  return {
    pid: 4242,
    usename: "app_user",
    applicationName: "orders-api",
    clientAddr: null,
    state: "active",
    waitEventType: null,
    waitEvent: null,
    backendType: "client backend",
    backendToken: TOKEN,
    xactAgeSeconds: 12,
    queryAgeSeconds: 12,
    stateAgeSeconds: 12,
    isExecuting: true,
    queryText: "SELECT * FROM orders",
    queryHidden: false,
    isBlocked: false,
    blockerPids: [],
    ...overrides,
  };
}

describe("session action eligibility", () => {
  it("offers both actions for an active named client session", () => {
    expect(sessionActionEligibility(row(), APP)).toEqual({
      cancel: true,
      terminate: true,
      ownedByThisApp: false,
      reason: null,
    });
  });

  it("offers only Terminate for sessions that are not running a query", () => {
    for (const state of ["idle", "idle in transaction"]) {
      expect(sessionActionEligibility(row({ state }), APP)).toMatchObject({
        cancel: false,
        terminate: true,
      });
    }
  });

  it("never offers actions on this app's own sessions", () => {
    expect(
      sessionActionEligibility(row({ applicationName: APP }), APP)
    ).toMatchObject({ cancel: false, terminate: false, ownedByThisApp: true });
    // Another PoliteDB instance is just another client.
    expect(
      sessionActionEligibility(
        row({ applicationName: "PoliteDB/00000000" }),
        APP
      ).terminate
    ).toBe(true);
  });

  it.each([
    [{ applicationName: "" }, "Session has no application name"],
    [{ applicationName: null }, "Session has no application name"],
    [{ backendType: "autovacuum worker" }, "Not a client session"],
    [{ backendToken: null }, "Session details are hidden from this role"],
    [{ pid: 0 }, "Session details are hidden from this role"],
    [{ pid: null }, "Session details are hidden from this role"],
  ])("refuses %o", (overrides, reason) => {
    expect(sessionActionEligibility(row(overrides), APP)).toMatchObject({
      cancel: false,
      terminate: false,
      reason,
    });
  });

  it("hides everything when this app's name is unknown", () => {
    expect(sessionActionEligibility(row(), null)).toMatchObject({
      cancel: false,
      terminate: false,
      ownedByThisApp: false,
    });
  });
});

describe("confirmation text", () => {
  it("strips controls, line breaks and bidi overrides, and caps length", () => {
    expect(sanitizeDialogText("a\nb\r\tc\u0000d", 50)).toBe("a b c d");
    expect(sanitizeDialogText("evil‮txt.exe⁦x⁩", 50)).toBe("evil txt.exe x");
    expect(sanitizeDialogText("x".repeat(10), 5)).toBe("xxxx…");
    expect(sanitizeDialogText(null, 5)).toBe("");
  });

  it("describes the action and the session in the body alone", () => {
    const c = sessionActionConfirmation(
      "cancel",
      row({ queryText: "SELECT 1\n-- ‮secret" }),
      "shop\nprod"
    );
    expect(c.okLabel).toBe("Cancel query");
    expect(c.cancelLabel).toBe("Keep running");
    expect(c.body).toContain("Cancel the query running in session 4242?");
    expect(c.body).toContain("stops whatever the session is running");
    expect(c.body).toContain("Database: shop prod");
    expect(c.body).toContain("User: app_user · App: orders-api");
    expect(c.body).toContain("Query: SELECT 1 -- secret");
    expect(c.body).not.toContain("‮");

    const t = sessionActionConfirmation(
      "terminate",
      row({ queryHidden: true, queryText: "<insufficient privilege>" }),
      null
    );
    expect(t.okLabel).toBe("Terminate session");
    expect(t.body).toContain("Terminate session 4242?");
    expect(t.body).toContain("Its open transaction is rolled back.");
    expect(t.body).toContain("Query: (hidden)");
  });

  it("has a fixed message for every outcome", () => {
    for (const outcome of SESSION_ACTION_OUTCOMES) {
      const message = sessionActionOutcomeMessage("terminate", 7, outcome);
      expect(message.length).toBeGreaterThan(0);
    }
    expect(sessionActionOutcomeMessage("cancel", 7, "unknown")).toContain(
      "may or may not have been sent"
    );
    expect(sessionActionOutcomeMessage("cancel", 7, "busy")).toContain(
      "not sent"
    );
  });
});

describe("backend token", () => {
  it("accepts only the server's exact shape", () => {
    expect(decodeBackendToken(TOKEN)).toBe(TOKEN);
    expect(decodeBackendToken("2026-10-22T03:04:05.123Z")).toBeNull();
    expect(decodeBackendToken("2026-10-22T03:04:05.123456+00:00")).toBeNull();
    expect(decodeBackendToken(null)).toBeNull();
  });

  it("uses the same expression as the Rust signal statement", () => {
    expect(healthInspectorSessionsSql()).toContain("AS backend_token");
    const rust = readFileSync(
      resolve(
        __dirname,
        "../../../src-tauri/src/engines/postgres/session_signal.rs"
      ),
      "utf8"
    );
    // Same column, same UTC conversion, same microsecond format.
    expect(HEALTH_INSPECTOR_BACKEND_TOKEN_SQL).toContain(
      "a.backend_start AT TIME ZONE 'UTC'"
    );
    expect(rust).toContain("a.backend_start AT TIME ZONE 'UTC'");
    const format = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
    expect(HEALTH_INSPECTOR_BACKEND_TOKEN_SQL).toContain(format);
    expect(rust).toContain(format.replace(/"/g, '\\"'));
  });
});
