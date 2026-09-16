import { describe, expect, it } from "vitest";
import {
  DIAGRAM_DETAIL_ZOOM,
  DIAGRAM_VIEWPORT_BUCKET,
  getDiagramSurfaceSize,
  getDiagramSvgViewBox,
  getDiagramViewport,
  getVisibleIndexWindow,
  isDiagramRectVisible,
  shouldRenderDiagramTableDetails,
} from "./diagramViewport";

describe("diagram viewport", () => {
  it("converts scaled scroll metrics to bucketed logical coordinates", () => {
    expect(getDiagramViewport(260, 500, 800, 600, 2)).toEqual({
      left: DIAGRAM_VIEWPORT_BUCKET,
      top: DIAGRAM_VIEWPORT_BUCKET * 2,
      width: 400,
      height: 300,
    });
  });

  it("keeps nearby diagram items mounted inside overscan", () => {
    const viewport = { left: 1000, top: 1000, width: 500, height: 400 };

    expect(
      isDiagramRectVisible(
        { x: 700, y: 800, width: 100, height: 100 },
        viewport,
        250
      )
    ).toBe(true);
    expect(
      isDiagramRectVisible(
        { x: 100, y: 100, width: 100, height: 100 },
        viewport,
        250
      )
    ).toBe(false);
  });

  it("keeps relations whose bounding boxes cross the viewport", () => {
    expect(
      isDiagramRectVisible(
        { x: 100, y: 1150, width: 1800, height: 10 },
        { left: 1000, top: 1000, width: 500, height: 400 },
        0
      )
    ).toBe(true);
  });

  it("hides column details below the diagram detail zoom", () => {
    expect(shouldRenderDiagramTableDetails(1)).toBe(true);
    expect(shouldRenderDiagramTableDetails(DIAGRAM_DETAIL_ZOOM)).toBe(true);
    expect(shouldRenderDiagramTableDetails(DIAGRAM_DETAIL_ZOOM - 0.01)).toBe(
      false
    );
  });

  it("windows list rows to the visible range", () => {
    expect(getVisibleIndexWindow(0, 28, 80, 0, 280)).toEqual({
      start: 0,
      end: 10,
    });
    expect(getVisibleIndexWindow(0, 28, 80, 560, 840)).toEqual({
      start: 20,
      end: 30,
    });
    expect(getVisibleIndexWindow(100, 28, 4, 0, 50)).toEqual({
      start: 0,
      end: 0,
    });
  });

  it("clips the relation svg to the overscanned viewport", () => {
    expect(
      getDiagramSvgViewBox(
        { left: 1000, top: 800, width: 500, height: 400 },
        4000,
        3000,
        200
      )
    ).toEqual({
      x: 800,
      y: 600,
      width: 900,
      height: 800,
    });
  });

  it("grows the dotted surface to at least the visible viewport", () => {
    expect(getDiagramSurfaceSize(400, 300, 900, 700)).toEqual({
      width: 900,
      height: 700,
    });
    expect(getDiagramSurfaceSize(1200, 1000, 800, 600)).toEqual({
      width: 1200,
      height: 1000,
    });
  });
});
