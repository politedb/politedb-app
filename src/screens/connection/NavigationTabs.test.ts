import { describe, expect, it } from "vitest";
import {
  getTabRevealScrollLeft,
  navigationTabClass,
  navigationTabCloseClass,
} from "./NavigationTabs";

describe("getTabRevealScrollLeft", () => {
  it("moves a clipped left-edge tab fully into view", () => {
    expect(
      getTabRevealScrollLeft({
        scrollLeft: 120,
        viewportLeft: 40,
        viewportRight: 340,
        tabLeft: 25,
        tabRight: 105,
      })
    ).toBe(101);
  });

  it("moves a clipped right-edge tab fully into view", () => {
    expect(
      getTabRevealScrollLeft({
        scrollLeft: 120,
        viewportLeft: 40,
        viewportRight: 340,
        tabLeft: 300,
        tabRight: 365,
      })
    ).toBe(149);
  });

  it("does not move a fully visible tab", () => {
    expect(
      getTabRevealScrollLeft({
        scrollLeft: 120,
        viewportLeft: 40,
        viewportRight: 340,
        tabLeft: 80,
        tabRight: 200,
      })
    ).toBeNull();
  });
});

describe("navigationTabClass", () => {
  it("renders the active table tab as a white card with a blue top edge", () => {
    const active = navigationTabClass(true);
    const idle = navigationTabClass(false);

    expect(active).toContain("rounded-lg");
    expect(active).toContain("bg-white");
    expect(active).toContain("before:bg-blue-600");
    expect(active).toContain("before:h-[2.5px]");
    expect(idle).toContain("bg-transparent");
    expect(idle).not.toContain("before:bg-blue-600");
    expect(idle).not.toContain("bg-neutral-200/70");
  });

  it("keeps the close control visible", () => {
    expect(navigationTabCloseClass()).not.toContain("opacity-0");
  });
});
