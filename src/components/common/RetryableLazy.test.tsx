import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { createRetryableLazy } from "./RetryableLazy";

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
});
