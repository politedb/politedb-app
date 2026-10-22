import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/preact";
import { Dialog } from "src/components/common/Dialog";
import { InfoHint } from "./InfoHint";

function tooltipFor(hint: HTMLElement): HTMLElement {
  return document.getElementById(hint.getAttribute("aria-describedby")!)!;
}

describe("InfoHint", () => {
  it("describes its marker and shows the text on keyboard focus", () => {
    render(<InfoHint text="Counters since the last reset." />);
    const hint = screen.getByRole("img", { name: "More info" });
    const tooltip = tooltipFor(hint);
    expect(tooltip.textContent).toBe("Counters since the last reset.");
    expect(tooltip.hidden).toBe(true);

    act(() => hint.focus());
    expect(tooltip.hidden).toBe(false);
    act(() => hint.blur());
    expect(tooltip.hidden).toBe(true);
  });

  it("hides a hover-opened hint on Escape before the dialog closes", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose}>
        <button type="button">Refresh</button>
        <InfoHint text="Hint" />
      </Dialog>
    );
    const button = screen.getByRole("button", { name: "Refresh" });
    act(() => button.focus());
    const hint = screen.getByRole("img", { name: "More info" });

    fireEvent.mouseEnter(hint);
    expect(tooltipFor(hint).hidden).toBe(false);
    // Focus stays on the button, so the key event targets the button.
    fireEvent.keyDown(button, { key: "Escape" });
    expect(tooltipFor(hint).hidden).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    // Once hidden, Escape closes the dialog again.
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", () => {
    const onDocumentEscape = vi.fn();
    document.addEventListener("keydown", onDocumentEscape);
    const { unmount } = render(<InfoHint text="Hint" />);
    fireEvent.mouseEnter(screen.getByRole("img", { name: "More info" }));
    unmount();
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDocumentEscape).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", onDocumentEscape);
  });
});
