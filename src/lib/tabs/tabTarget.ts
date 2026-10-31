import type { ConnectionProfile, RuntimeTarget } from "src/lib/tauri/types";
import type { DatabaseEngine } from "src/types";
import type { ProfileTab, TabTarget } from "src/stores/screen";
import { currentDatabaseFromInput } from "src/lib/connection/connection";

/*
 * What a connection tab is opened on (plan tab-database-reconnect R2, R12):
 * the one derivation used for connecting, display, SQL scope, metadata and
 * drop checks. A tab's label is never read.
 */

/** Engines whose tabs can be opened on another database ("Open database"). */
const OVERRIDE_ENGINES: ReadonlySet<DatabaseEngine> = new Set<DatabaseEngine>([
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
  "mongo",
  "sqlite",
  "oracle",
  "clickhouse",
  "cassandra",
]);

export function supportsDatabaseOverride(engine?: DatabaseEngine): boolean {
  return !!engine && OVERRIDE_ENGINES.has(engine);
}

const UNKNOWN: TabTarget = { kind: "unknown" };

/**
 * A persisted `target` as restored: missing (a tab saved before targets were
 * recorded, default ones included), malformed, blank or unsupported →
 * unknown. Never inferred from the label or the `databaseOverride` mirror.
 */
export function normalizePersistedTarget(
  raw: unknown,
  engine?: DatabaseEngine
): TabTarget {
  if (!raw || typeof raw !== "object") return UNKNOWN;
  const value = raw as { kind?: unknown; database?: unknown };
  if (value.kind === "default") return { kind: "default" };
  if (value.kind === "override") {
    const database =
      typeof value.database === "string" ? value.database.trim() : "";
    if (!database || !supportsDatabaseOverride(engine)) return UNKNOWN;
    return { kind: "override", database };
  }
  return UNKNOWN;
}

/** The `databaseOverride` display mirror of a target. */
export function overrideMirror(target: TabTarget): string | undefined {
  return target.kind === "override" ? target.database : undefined;
}

export type IntendedTarget = {
  profileId: string;
  /** The database opened instead of the profile's own; null = its own. */
  override: string | null;
};

export type ResolvedTabTarget =
  | { state: "ok"; intended: IntendedTarget; display: string }
  | { state: "unknown"; intended: null; display: "" };

/** What `tab` is opened on, or unknown (it then never connects, R7). */
export function resolveTabTarget(
  tab: Pick<ProfileTab, "profileId" | "engine" | "target"> | null | undefined,
  profile: Pick<ConnectionProfile, "engine" | "input"> | null | undefined
): ResolvedTabTarget {
  const target = tab?.target;
  if (!tab || !target || target.kind === "unknown") {
    return { state: "unknown", intended: null, display: "" };
  }
  if (target.kind === "override") {
    const database = target.database.trim();
    if (!database || !supportsDatabaseOverride(tab.engine)) {
      return { state: "unknown", intended: null, display: "" };
    }
    return {
      state: "ok",
      intended: { profileId: tab.profileId, override: database },
      display: database,
    };
  }
  return {
    state: "ok",
    intended: { profileId: tab.profileId, override: null },
    display: currentDatabaseFromInput(profile?.engine, profile?.input),
  };
}

/**
 * Whether a runtime connection was opened on what `intended` asks for (the
 * same profile and override). Revision freshness is decided by the backend
 * on every use, never here.
 */
export function targetMatches(
  intended: IntendedTarget | null,
  runtime: RuntimeTarget | null | undefined
): boolean {
  if (!intended || !runtime) return false;
  return (
    runtime.profile_id === intended.profileId &&
    (runtime.database_override ?? null) === intended.override
  );
}

/** A tab's label: the profile's, plus the database it was opened on. */
export function tabLabelFor(
  profileLabel: string,
  target: { kind: string; database?: string } | undefined
): string {
  return target?.kind === "override" && target.database
    ? `${profileLabel} · ${target.database}`
    : profileLabel;
}
