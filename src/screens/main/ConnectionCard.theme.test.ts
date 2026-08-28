import { describe, expect, it } from "vitest";
import { getConnectionCardToneClass } from "./ConnectionCard";

describe("connection card theme", () => {
  it("keeps pinned favorites on a dark-safe amber surface", () => {
    const tone = getConnectionCardToneClass(false, true);
    expect(tone).toContain("bg-amber-50/40");
    expect(tone).toContain("dark:bg-amber-950/40");
  });

  it("keeps selected cards on a dark-safe blue surface", () => {
    const tone = getConnectionCardToneClass(true, false);
    expect(tone).toContain("bg-blue-50");
    expect(tone).toContain("dark:bg-blue-950/35");
  });

  it("keeps unpinned cards on the shared white/dark surface", () => {
    const tone = getConnectionCardToneClass(false, false);
    expect(tone).toContain("bg-white");
    expect(tone).toContain("dark:bg-slate-900");
  });
});
