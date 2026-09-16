import { describe, expect, it } from "vitest";
import { formatLicensePlanLabel } from "./license";

describe("formatLicensePlanLabel", () => {
  it("defaults to Free plan when plan_name missing", () => {
    expect(formatLicensePlanLabel(null)).toBe("Free plan");
    expect(formatLicensePlanLabel(undefined)).toBe("Free plan");
    expect(formatLicensePlanLabel("")).toBe("Free plan");
    expect(formatLicensePlanLabel("   ")).toBe("Free plan");
  });

  it("title-cases backend plan names", () => {
    expect(formatLicensePlanLabel("ultimate")).toBe("Ultimate plan");
    expect(formatLicensePlanLabel("FREE")).toBe("Free plan");
    expect(formatLicensePlanLabel("Pro")).toBe("Pro plan");
  });

  it("avoids duplicating a trailing plan suffix", () => {
    expect(formatLicensePlanLabel("Ultimate plan")).toBe("Ultimate plan");
    expect(formatLicensePlanLabel("free PLAN")).toBe("Free plan");
  });
});
