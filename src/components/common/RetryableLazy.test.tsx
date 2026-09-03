import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { ComponentChildren } from "preact";
import { useErrorBoundary } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { createRetryableLazy } from "./RetryableLazy";

function ParentBoundary(props: { children: ComponentChildren }) {
  const [error] = useErrorBoundary();
  return error ? <div>Runtime render failed</div> : <>{props.children}</>;
}

describe("createRetryableLazy", () => {
  it("recreates the lazy component when a failed import is retried", async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValue({ default: () => <div>Loaded content</div> });
    const LazyContent = createRetryableLazy(loader, {
      label: "test content",
      renderFallback: () => <div>Loading content</div>,
    });

    render(<LazyContent />);
    expect(screen.getByText("Loading content")).toBeInTheDocument();
    expect(
      await screen.findByText("Failed to load test content.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByText("Loaded content")).toBeInTheDocument()
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("rethrows component render errors to the parent boundary", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const LazyContent = createRetryableLazy(
      async () => ({
        default: () => {
          throw new Error("render failed");
        },
      }),
      { label: "test content" }
    );

    render(
      <ParentBoundary>
        <LazyContent />
      </ParentBoundary>
    );

    expect(
      await screen.findByText("Runtime render failed")
    ).toBeInTheDocument();
    expect(screen.queryByText("Failed to load test content.")).toBeNull();
    consoleError.mockRestore();
  });
});
