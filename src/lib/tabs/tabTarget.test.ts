import { describe, expect, it } from "vitest";
import {
  normalizePersistedTarget,
  overrideMirror,
  resolveTabTarget,
  targetMatches,
} from "./tabTarget";

const pg = {
  engine: "postgres" as const,
  input: { engine: "postgres", postgres: { database: "app" } } as never,
};

describe("persisted tab targets (R12)", () => {
  it("never infers a target: missing, malformed, blank or unsupported is unknown", () => {
    for (const raw of [
      undefined,
      null,
      "default",
      42,
      {},
      { kind: "other" },
      { kind: "override" },
      { kind: "override", database: "  " },
      { kind: "override", database: 5 },
    ]) {
      expect(normalizePersistedTarget(raw, "postgres")).toEqual({
        kind: "unknown",
      });
    }
    // An engine without "Open database".
    expect(
      normalizePersistedTarget({ kind: "override", database: "1" }, "redis")
    ).toEqual({ kind: "unknown" });
  });

  it("keeps what a tab recorded", () => {
    expect(normalizePersistedTarget({ kind: "default" }, "postgres")).toEqual({
      kind: "default",
    });
    expect(
      normalizePersistedTarget(
        { kind: "override", database: " b " },
        "postgres"
      )
    ).toEqual({ kind: "override", database: "b" });
    expect(normalizePersistedTarget({ kind: "unknown" }, "postgres")).toEqual({
      kind: "unknown",
    });
    expect(overrideMirror({ kind: "override", database: "b" })).toBe("b");
    expect(overrideMirror({ kind: "default" })).toBeUndefined();
  });
});

describe("what a tab is opened on (R2)", () => {
  const tab = (target: unknown, extra: object = {}) =>
    ({ profileId: "p1", engine: "postgres", target, ...extra }) as never;

  it("reads the target only, never the label or the mirror", () => {
    expect(resolveTabTarget(tab({ kind: "default" }), pg)).toEqual({
      state: "ok",
      intended: { profileId: "p1", override: null },
      display: "app",
    });
    expect(
      resolveTabTarget(tab({ kind: "override", database: "b" }), pg)
    ).toMatchObject({ intended: { override: "b" }, display: "b" });
    // A label or a mirror that disagrees changes nothing.
    expect(
      resolveTabTarget(
        tab(
          { kind: "default" },
          { label: "Athena · b", databaseOverride: "b" }
        ),
        pg
      ).intended
    ).toEqual({ profileId: "p1", override: null });
    expect(resolveTabTarget(tab({ kind: "unknown" }), pg).state).toBe(
      "unknown"
    );
    expect(resolveTabTarget(tab(undefined), pg).state).toBe("unknown");
  });

  it("matches a connection opened on the same profile and database", () => {
    const runtime = (override: string | null, profile = "p1") => ({
      profile_id: profile,
      profile_revision: "r",
      database_override: override,
      engine: "postgres" as const,
      display: override ?? "app",
    });
    const intended = { profileId: "p1", override: "b" };
    expect(targetMatches(intended, runtime("b"))).toBe(true);
    expect(targetMatches(intended, runtime(null))).toBe(false);
    expect(targetMatches(intended, runtime("b", "p2"))).toBe(false);
    expect(targetMatches(intended, null)).toBe(false);
    expect(targetMatches(null, runtime("b"))).toBe(false);
    // An override equal to the profile's own database is still an override.
    expect(
      targetMatches({ profileId: "p1", override: null }, runtime("app"))
    ).toBe(false);
  });
});
