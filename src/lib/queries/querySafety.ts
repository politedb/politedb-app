import type { ConnectionProfile } from "src/lib/tauri";

export type QuerySafetyMode = "default" | "lock" | "safe" | "production";

export function isProductionTag(tag: string) {
  const normalized = tag.trim().toLowerCase();
  return normalized === "prod" || normalized === "production";
}

export function hasProductionTag(tags: readonly string[] | undefined | null) {
  return (tags ?? []).some(isProductionTag);
}

export function defaultQuerySafetyModeForProfile(
  profile: Pick<ConnectionProfile, "input"> | null | undefined
): QuerySafetyMode {
  return hasProductionTag(profile?.input?.tags) ? "production" : "default";
}

export function normalizeQuerySafetyMode(value: unknown): QuerySafetyMode {
  if (
    value === "default" ||
    value === "lock" ||
    value === "safe" ||
    value === "production"
  ) {
    return value;
  }
  return "default";
}

/** A locked profile tab acts as lock mode, whatever the profile's mode. */
export function effectiveSafetyMode(
  mode: QuerySafetyMode,
  profileLocked: boolean
): QuerySafetyMode {
  return mode === "lock" || profileLocked ? "lock" : mode;
}

/**
 * Reading data (Run of non-mutating statements, Explain Analyze) asks for
 * Touch ID in safe and production modes. Shared by both paths so they cannot
 * drift apart.
 */
export function readNeedsTouchId(mode: QuerySafetyMode): boolean {
  return mode === "safe" || mode === "production";
}

export function readTouchIdPrompt(mode: QuerySafetyMode): string {
  return mode === "production"
    ? "Authenticate with Touch ID before reading production data."
    : "Authenticate with Touch ID before sending queries.";
}
