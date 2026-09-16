import type { TelemetryConsent } from "src/lib/analytics";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import type { DatabaseEngine } from "src/types";
import { normalizeEngineName } from "src/utils/convert";

export type AppStatusBarDot = "connected" | "connecting" | "idle";

export type AppStatusBarModel = {
  dot: AppStatusBarDot;
  left: string[];
  right: string[];
};

export function querySafetyStatusLabel(mode: QuerySafetyMode): string {
  switch (mode) {
    case "lock":
      return "Query mode: Lock";
    case "safe":
      return "Query mode: Safe";
    case "production":
      return "Query mode: Production";
    default:
      return "Query mode: Default";
  }
}

export function formatAppVersionLabel(version: string, isDev: boolean): string {
  return `PoliteDB v${version}${isDev ? "-dev" : ""}`;
}

export function buildAppStatusBarModel(input: {
  isConnectionTab: boolean;
  engine?: DatabaseEngine;
  connected: boolean;
  querySafetyMode?: QuerySafetyMode;
  appVersion: string;
  isDev: boolean;
  telemetryConsent: TelemetryConsent;
}): AppStatusBarModel {
  const engineLabel = normalizeEngineName(input.engine ?? "postgres");
  const right = [
    input.isConnectionTab
      ? "Tips: Right-click a table for actions"
      : "Tips: Right-click a connection for actions",
    formatAppVersionLabel(input.appVersion, input.isDev),
  ];

  if (!input.isConnectionTab) {
    return {
      dot: "idle",
      left: ["No active connection"],
      right,
    };
  }

  if (!input.connected) {
    return {
      dot: "connecting",
      left: [`Connecting: ${engineLabel}`],
      right,
    };
  }

  const left = [`Connected: ${engineLabel}`];
  if (input.querySafetyMode) {
    left.push(querySafetyStatusLabel(input.querySafetyMode));
  }

  return { dot: "connected", left, right };
}
