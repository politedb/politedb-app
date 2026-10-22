import { renderHook } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollMemory } from "./useScrollMemory";

let resize: () => void = () => {};
class ResizeObserverMock {
  constructor(cb: () => void) {
    resize = cb;
  }
  observe() {}
  disconnect() {}
}

/** A scroller whose scrollTop is clamped to a settable maximum, like a browser. */
function makeScroller() {
  // Like OverlayScrollArea: the scroller and the overlay thumb are siblings.
  const wrapper = document.createElement("div");
  const el = document.createElement("div");
  const thumb = document.createElement("div");
  thumb.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.appendChild(document.createElement("div"));
  wrapper.append(el, thumb);
  let top = 0;
  const geometry = { max: 0 };
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, geometry.max));
      el.dispatchEvent(new Event("scroll"));
    },
  });
  return { el, geometry, thumb };
}

function setup(
  target: number,
  current = { page: "a" },
  shared?: ReturnType<typeof makeScroller>
) {
  const { el, geometry, thumb } = shared ?? makeScroller();
  const saved: Record<string, number> = { a: target };
  const write = vi.fn((key: string, top: number) => (saved[key] = top));
  const hook = renderHook(
    ({ page }) =>
      useScrollMemory({
        key: page,
        getScroller: () => el,
        read: (key) => saved[key] ?? 0,
        write,
        isCurrent: (key) => key === current.page,
      }),
    { initialProps: { page: current.page } }
  );
  return { el, geometry, thumb, saved, write, hook, current };
}

beforeEach(() => vi.stubGlobal("ResizeObserver", ResizeObserverMock));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useScrollMemory", () => {
  it("restores once the content has grown enough", () => {
    const { el, geometry, write } = setup(400);
    expect(el.scrollTop).toBe(0); // nothing loaded yet

    geometry.max = 1000; // the list loaded
    resize();
    expect(el.scrollTop).toBe(400);
    // Positions set while restoring are never saved as the user's.
    expect(write).not.toHaveBeenCalled();
  });

  it("stops restoring as soon as the user scrolls", () => {
    const { el, geometry, write, saved } = setup(400);
    el.dispatchEvent(new Event("wheel"));

    geometry.max = 1000;
    resize();
    expect(el.scrollTop).toBe(0);

    el.scrollTop = 120; // the user's own scroll
    expect(write).toHaveBeenLastCalledWith("a", 120);
    expect(saved.a).toBe(120);
  });

  it("gives up after a while instead of jumping much later", () => {
    vi.useFakeTimers();
    const { el, geometry } = setup(400);
    vi.advanceTimersByTime(6000);

    geometry.max = 1000;
    resize();
    expect(el.scrollTop).toBe(0);
  });

  it("ignores the browser clamping a page that is no longer shown", () => {
    const { el, geometry, write, current, saved } = setup(0);
    geometry.max = 1000;
    el.scrollTop = 600;
    expect(saved.a).toBe(600);

    // Switch to a short page: the shared scroller gets clamped.
    current.page = "b";
    geometry.max = 50;
    el.scrollTop = 600;
    expect(write).not.toHaveBeenCalledWith("a", 50);
    expect(saved.a).toBe(600);
  });

  it("opens a page saved at the top at the top, not where the last one was", () => {
    const shared = makeScroller();
    shared.geometry.max = 1000;
    shared.el.scrollTop = 600; // the previous page was left here

    setup(0, { page: "a" }, shared);
    expect(shared.el.scrollTop).toBe(0);
  });

  it("stops restoring when the overlay scrollbar is dragged", () => {
    const { el, geometry, thumb, write } = setup(400);
    thumb.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    geometry.max = 1000;
    resize();
    expect(el.scrollTop).toBe(0);

    el.scrollTop = 90; // the drag moves the content
    expect(write).toHaveBeenLastCalledWith("a", 90);
  });
});
