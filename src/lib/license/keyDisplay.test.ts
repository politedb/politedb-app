import { describe, expect, it } from "vitest";
import { maskLicenseKey } from "./keyDisplay";

describe("maskLicenseKey", () => {
  it("keeps the start and the last four characters", () => {
    expect(maskLicenseKey("PLD-ABCDEF12-3456-7890-ABCD-1234567890AB")).toBe(
      "PLD-ABCD…90AB"
    );
  });

  it("never shows a short key whole", () => {
    expect(maskLicenseKey("SHORT-KEY-1")).toBe("…EY-1");
  });

  it("is empty without a key", () => {
    expect(maskLicenseKey(null)).toBe("");
    expect(maskLicenseKey("  ")).toBe("");
  });
});
