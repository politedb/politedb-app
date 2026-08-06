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
