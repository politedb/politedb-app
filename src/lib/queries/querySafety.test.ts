import { describe, expect, it } from "vitest";
import {
  defaultQuerySafetyModeForProfile,
  hasProductionTag,
  normalizeQuerySafetyMode,
} from "./querySafety";

describe("querySafety", () => {
  it("detects production tags exactly, case-insensitively", () => {
    expect(hasProductionTag(["prod"])).toBe(true);
    expect(hasProductionTag(["Production"])).toBe(true);
    expect(hasProductionTag(["staging", "PROD"])).toBe(true);
    expect(hasProductionTag(["product", "nonprod", "dev"])).toBe(false);
  });

  it("defaults tagged profiles to production mode", () => {
    expect(
      defaultQuerySafetyModeForProfile({
        input: { tags: ["prod"] },
      } as any)
    ).toBe("production");

    expect(
      defaultQuerySafetyModeForProfile({
        input: { tags: ["local"] },
      } as any)
    ).toBe("default");
  });

  it("normalizes persisted mode values", () => {
    expect(normalizeQuerySafetyMode("production")).toBe("production");
    expect(normalizeQuerySafetyMode("safe")).toBe("safe");
    expect(normalizeQuerySafetyMode("unknown")).toBe("default");
  });
});
