import { describe, expect, it } from "vitest";

/**
 * Documents the layout-intent reset rule used by SplitPane:
 * when initialRatio / fixedPaneOnResize change (e.g. toggling the
 * left sidebar), the stored first-pane pixel size must be discarded
 * so the new ratio is applied. Without that, Preact reuse keeps the
 * old width and a sidebar can swallow most of the screen.
 */
function shouldResetSplitSize(
  prev: { initialRatio: number; fixedPaneOnResize: "first" | "second" },
  next: { initialRatio: number; fixedPaneOnResize: "first" | "second" }
) {
  return (
    prev.initialRatio !== next.initialRatio ||
    prev.fixedPaneOnResize !== next.fixedPaneOnResize
  );
}

describe("SplitPane layout intent", () => {
  it("resets when switching left-sidebar mode to main+right mode", () => {
    expect(
      shouldResetSplitSize(
        { initialRatio: 0.15, fixedPaneOnResize: "first" },
        { initialRatio: 0.75, fixedPaneOnResize: "second" }
      )
    ).toBe(true);
  });

  it("does not reset when only the container size changes", () => {
    expect(
      shouldResetSplitSize(
        { initialRatio: 0.15, fixedPaneOnResize: "first" },
        { initialRatio: 0.15, fixedPaneOnResize: "first" }
      )
    ).toBe(false);
  });
});
