import { h } from "preact";
import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

vi.mock("../connection/ConnectionFormDialog.tsx", () => ({
  ConnectionFormDialog: () => null,
}));

import { ConnectionModal } from "./ConnectionModal";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("ConnectionModal engine picker", () => {
  it("opens without errors and focuses the search field", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      h(ConnectionModal, {
        onSaved: vi.fn(),
        onClose: vi.fn(),
        showDatabaseForm: undefined,
        setShowDatabaseForm: vi.fn(),
      })
    );

    const search = screen.getByPlaceholderText("Search engines…");
    expect(document.activeElement).toBe(search);
    expect(errors).not.toHaveBeenCalled();

    errors.mockRestore();
    vi.unstubAllGlobals();
  });
});
