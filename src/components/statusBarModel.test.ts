import { describe, expect, it } from "vitest";
import {
  buildAppStatusBarModel,
  formatAppVersionLabel,
  querySafetyStatusLabel,
} from "./statusBarModel";

describe("app status bar model", () => {
  it("shows explorer copy when no connection tab is open", () => {
    const model = buildAppStatusBarModel({
      isConnectionTab: false,
      connected: false,
      appVersion: "1.2.8",
      isDev: false,
      telemetryConsent: "granted",
    });

    expect(model.dot).toBe("idle");
    expect(model.left).toEqual(["No active connection"]);
    expect(model.right).toEqual([
      "Tips: Right-click a connection for actions",
      "PoliteDB v1.2.8",
    ]);
  });

  it("shows engine and query mode for a live connection", () => {
    const model = buildAppStatusBarModel({
      isConnectionTab: true,
      engine: "sqlite",
      connected: true,
      querySafetyMode: "production",
      appVersion: "1.2.8",
      isDev: false,
      telemetryConsent: "denied",
    });

    expect(model.dot).toBe("connected");
    expect(model.left).toEqual(["Connected: SQLite", "Query mode: Production"]);
    expect(model.right[0]).toBe("Tips: Right-click a table for actions");
    expect(model.right[2]).toBe("Telemetry: Off");
  });

  it("marks a connection tab without a runtime as connecting", () => {
    const model = buildAppStatusBarModel({
      isConnectionTab: true,
      engine: "postgres",
      connected: false,
      appVersion: "1.2.8",
      isDev: true,
      telemetryConsent: "unknown",
    });

    expect(model.dot).toBe("connecting");
    expect(model.left).toEqual(["Connecting: Postgres"]);
    expect(model.right[1]).toBe("PoliteDB v1.2.8-dev");
    expect(model.right[2]).toBe("Telemetry: Not set");
  });
});

describe("app status bar labels", () => {
  it("maps query safety modes", () => {
    expect(querySafetyStatusLabel("default")).toBe("Query mode: Default");
    expect(querySafetyStatusLabel("lock")).toBe("Query mode: Lock");
    expect(querySafetyStatusLabel("safe")).toBe("Query mode: Safe");
  });

  it("keeps the desktop version suffix stable", () => {
    expect(formatAppVersionLabel("1.4.2", false)).toBe("PoliteDB v1.4.2");
  });
});
