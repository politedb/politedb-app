import { h } from "preact";
import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

vi.mock("src/lib/analytics", () => ({
  getTelemetryConsent: () => "denied",
  setTelemetryConsent: vi.fn(),
}));

import { AnalyticsSettings } from "./AnalyticsSettings";

describe("AnalyticsSettings", () => {
  it("puts the switch first and explains what is sent below it", () => {
    const { container } = render(h(AnalyticsSettings, { active: true }));
    const text = container.textContent ?? "";

    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(text.indexOf("Allow detailed product analytics")).toBeLessThan(
      text.indexOf("Always sent")
    );
    expect(text).toContain("random install ID");
    expect(text).toContain("Not included in events");
    expect(text).not.toContain("Always tracked");
    // Honest about error messages instead of promising nothing leaks.
    // Errors are sent only as a category, so the text can say so plainly.
    expect(text).toContain("only a short category");
    expect(text).not.toContain("Never sent");
  });
});
