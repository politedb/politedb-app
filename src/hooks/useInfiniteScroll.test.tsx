import { act, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInfiniteScroll } from "./useInfiniteScroll";

const observerCallbacks: IntersectionObserverCallback[] = [];
const observe = vi.fn();

class IntersectionObserverMock {
  constructor(callback: IntersectionObserverCallback) {
    observerCallbacks.push(callback);
  }

  observe = observe;
  disconnect() {}
}

function TestList(props: { expanded: boolean }) {
  const { visibleItems, sentinelRef, hasMore } = useInfiniteScroll(
    Array.from({ length: 30 }, (_, index) => index),
    { pageSize: 10 }
  );

  if (!props.expanded) return null;

  return (
    <div data-scroll-root>
      {visibleItems.map((item) => (
        <div key={item} data-list-item />
      ))}
      {hasMore ? <div ref={sentinelRef} data-sentinel /> : null}
    </div>
  );
}

describe("useInfiniteScroll", () => {
  beforeEach(() => {
    observerCallbacks.length = 0;
    observe.mockClear();
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("observes a sentinel mounted after the initial render", () => {
    const view = render(<TestList expanded={false} />);

    expect(observe).not.toHaveBeenCalled();
    view.rerender(<TestList expanded />);

    expect(observe).toHaveBeenCalledTimes(1);

    act(() => {
      observerCallbacks[observerCallbacks.length - 1]?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(view.container.querySelectorAll("[data-list-item]")).toHaveLength(
      20
    );
  });
});
