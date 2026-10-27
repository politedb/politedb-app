import type { TelemetryConsent } from "src/lib/analytics";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import type { DatabaseEngine } from "src/types";
import { normalizeEngineName } from "src/utils/convert";

export type AppStatusBarDot = "connected" | "connecting" | "idle";

export type AppStatusBarModel = {
  dot: AppStatusBarDot;
  left: string[];
  /** The live connection's query safety mode, shown as a badge. */
  mode?: QuerySafetyMode;
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
  /** The connection tab's name. */
  label?: string;
  engine?: DatabaseEngine;
  connected: boolean;
  querySafetyMode?: QuerySafetyMode;
  appVersion: string;
  isDev: boolean;
  telemetryConsent: TelemetryConsent;
}): AppStatusBarModel {
  const engineLabel = normalizeEngineName(input.engine ?? "postgres");
  const right = [formatAppVersionLabel(input.appVersion, input.isDev)];

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
  if (input.label) left.push(input.label);

  return { dot: "connected", left, mode: input.querySafetyMode, right };
}
