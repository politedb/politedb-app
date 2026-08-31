import { describe, expect, it } from "vitest";
import {
  buildDiagramSpatialIndex,
  getDiagramSpatialCandidates,
} from "./diagramSpatialIndex";

describe("diagram spatial index", () => {
  it("returns only buckets near the viewport", () => {
    const index = buildDiagramSpatialIndex(
      [
        [{ x: 0, y: 0, width: 100, height: 100 }],
        [{ x: 700, y: 0, width: 100, height: 100 }],
        [{ x: 3000, y: 3000, width: 100, height: 100 }],
      ],
      640
    );

    expect(
      getDiagramSpatialCandidates(
        index,
        { left: 0, top: 0, width: 800, height: 500 },
        0
      )
    ).toEqual([0, 1]);
  });

  it("deduplicates items spanning multiple segments and buckets", () => {
    const index = buildDiagramSpatialIndex(
      [
        [
          { x: 0, y: 10, width: 1500, height: 1 },
          { x: 700, y: 0, width: 1, height: 500 },
        ],
        [{ x: 5000, y: 5000, width: 10, height: 10 }],
      ],
      640
    );

    expect(
      getDiagramSpatialCandidates(
        index,
        { left: 600, top: 0, width: 400, height: 400 },
        100
      )
    ).toEqual([0]);
  });
});
