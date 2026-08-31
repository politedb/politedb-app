import type { DiagramRect, DiagramViewport } from "./diagramViewport";

const DEFAULT_SPATIAL_BUCKET_SIZE = 640;

export type DiagramSpatialIndex = {
  bucketSize: number;
  buckets: Map<string, number[]>;
};

function bucketKey(x: number, y: number) {
  return `${x}:${y}`;
}

function bucketRange(start: number, size: number, bucketSize: number) {
  const safeSize = Math.max(1, size);
  return {
    start: Math.floor(start / bucketSize),
    end: Math.floor((start + safeSize - Number.EPSILON) / bucketSize),
  };
}

export function buildDiagramSpatialIndex(
  rectGroups: readonly (readonly DiagramRect[])[],
  bucketSize = DEFAULT_SPATIAL_BUCKET_SIZE
): DiagramSpatialIndex {
  const safeBucketSize = Math.max(1, bucketSize);
  const buckets = new Map<string, number[]>();

  rectGroups.forEach((rects, index) => {
    const touchedBuckets = new Set<string>();
    for (const rect of rects) {
      if (
        !Number.isFinite(rect.x) ||
        !Number.isFinite(rect.y) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height)
      ) {
        continue;
      }
      const xRange = bucketRange(rect.x, rect.width, safeBucketSize);
      const yRange = bucketRange(rect.y, rect.height, safeBucketSize);
      for (let y = yRange.start; y <= yRange.end; y += 1) {
        for (let x = xRange.start; x <= xRange.end; x += 1) {
          touchedBuckets.add(bucketKey(x, y));
        }
      }
    }

    for (const key of touchedBuckets) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    }
  });

  return { bucketSize: safeBucketSize, buckets };
}

export function getDiagramSpatialCandidates(
  index: DiagramSpatialIndex,
  viewport: DiagramViewport,
  overscan: number
): number[] {
  const left = viewport.left - overscan;
  const top = viewport.top - overscan;
  const width = viewport.width + overscan * 2;
  const height = viewport.height + overscan * 2;
  const xRange = bucketRange(left, width, index.bucketSize);
  const yRange = bucketRange(top, height, index.bucketSize);
  const candidates = new Set<number>();

  for (let y = yRange.start; y <= yRange.end; y += 1) {
    for (let x = xRange.start; x <= xRange.end; x += 1) {
      for (const itemIndex of index.buckets.get(bucketKey(x, y)) ?? []) {
        candidates.add(itemIndex);
      }
    }
  }

  return Array.from(candidates).sort((a, b) => a - b);
}
