import { h } from "preact";
import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { OverlayScrollArea } from "./OverlayScrollArea";

describe("OverlayScrollArea", () => {
  it("lets a max-height parent clip through to the scroller", () => {
    const { container } = render(
      h(OverlayScrollArea, {
        className: "max-h-40",
        children: h("div", { style: { height: "400px" } }, "tall"),
      })
    );

    const scroller = container.querySelector(".no-scrollbar");
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain("max-h-[inherit]");
    expect(scroller?.className).toContain("overflow-y-auto");
  });
});
