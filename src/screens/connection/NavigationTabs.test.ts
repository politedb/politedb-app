import { describe, expect, it } from "vitest";
import { getTabRevealScrollLeft } from "./NavigationTabs";

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
