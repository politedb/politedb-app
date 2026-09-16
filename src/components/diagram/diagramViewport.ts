export type DiagramViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type DiagramRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const DEFAULT_DIAGRAM_VIEWPORT: DiagramViewport = {
  left: 0,
  top: 0,
  width: 0,
  height: 0,
};

export const DIAGRAM_VIEWPORT_OVERSCAN = 420;
export const DIAGRAM_VIEWPORT_BUCKET = 120;
export const DIAGRAM_DETAIL_ZOOM = 0.7;

export function getDiagramViewport(
  scrollLeft: number,
  scrollTop: number,
  clientWidth: number,
  clientHeight: number,
  zoom: number
): DiagramViewport {
  const safeZoom = zoom > 0 ? zoom : 1;
  const logicalLeft = scrollLeft / safeZoom;
  const logicalTop = scrollTop / safeZoom;

  return {
    left:
      Math.floor(logicalLeft / DIAGRAM_VIEWPORT_BUCKET) *
      DIAGRAM_VIEWPORT_BUCKET,
    top:
      Math.floor(logicalTop / DIAGRAM_VIEWPORT_BUCKET) *
      DIAGRAM_VIEWPORT_BUCKET,
    width: clientWidth / safeZoom,
    height: clientHeight / safeZoom,
  };
}

export function isDiagramRectVisible(
  rect: DiagramRect,
  viewport: DiagramViewport,
  overscan = DIAGRAM_VIEWPORT_OVERSCAN
): boolean {
  const right = viewport.left + viewport.width;
  const bottom = viewport.top + viewport.height;

  return (
    rect.x + rect.width >= viewport.left - overscan &&
    rect.x <= right + overscan &&
    rect.y + rect.height >= viewport.top - overscan &&
    rect.y <= bottom + overscan
  );
}

export function areDiagramViewportsEqual(
  a: DiagramViewport,
  b: DiagramViewport
): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}

export function shouldRenderDiagramTableDetails(zoom: number): boolean {
  return zoom >= DIAGRAM_DETAIL_ZOOM;
}

export function getVisibleIndexWindow(
  origin: number,
  itemSize: number,
  count: number,
  rangeStart: number,
  rangeEnd: number
): { start: number; end: number } {
  if (count <= 0 || itemSize <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor((rangeStart - origin) / itemSize));
  const end = Math.min(count, Math.ceil((rangeEnd - origin) / itemSize));
  if (end <= start) return { start: 0, end: 0 };
  return { start, end };
}

export function getDiagramSvgViewBox(
  viewport: DiagramViewport,
  layoutWidth: number,
  layoutHeight: number,
  overscan = DIAGRAM_VIEWPORT_OVERSCAN
): DiagramRect {
  const left = Math.max(0, viewport.left - overscan);
  const top = Math.max(0, viewport.top - overscan);
  const right = Math.min(
    layoutWidth,
    viewport.left + viewport.width + overscan
  );
  const bottom = Math.min(
    layoutHeight,
    viewport.top + viewport.height + overscan
  );
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Keep the dotted canvas at least as large as the visible viewport. */
export function getDiagramSurfaceSize(
  layoutWidth: number,
  layoutHeight: number,
  viewportWidth: number,
  viewportHeight: number
): { width: number; height: number } {
  return {
    width: Math.max(layoutWidth, Math.ceil(Math.max(0, viewportWidth))),
    height: Math.max(layoutHeight, Math.ceil(Math.max(0, viewportHeight))),
  };
}
