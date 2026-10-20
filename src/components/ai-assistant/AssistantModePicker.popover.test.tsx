import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";
import { resetAssistantModeForTests } from "src/lib/ai-assistant/assistantMode";
import { useLicenseStore } from "src/stores/license";
import { AssistantModePicker } from "./AssistantModePicker";

// Keep the app's Popover (its delayed mount is what matters here); only the third-party
// positioning layer, which jsdom cannot run, renders its content inline.
vi.mock("react-tiny-popover", () => ({
  Popover: ({ isOpen, content, children }: any) => (
    <div>
      {children}
      {isOpen ? content({ position: "top" }) : null}
    </div>
  ),
}));

const trigger = () => screen.getByRole("button", { name: /Assistant mode/ });
const item = (name: string) =>
  screen.getByRole("menuitemradio", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetAssistantModeForTests();
  useLicenseStore.setState({ state: { pro_access: true } as LicenseState });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AssistantModePicker with the app Popover", () => {
  it("focuses the selected mode once the menu mounts, also after a full close", async () => {
    render(<AssistantModePicker />);
    for (let round = 0; round < 2; round += 1) {
      fireEvent.click(trigger());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(document.activeElement).toBe(item("Agent"));
      fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(item("Manual"));
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(document.activeElement).toBe(trigger());
      // Let the close transition unmount the menu before reopening.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("focuses the selected mode when reopened during the close transition", async () => {
    render(<AssistantModePicker />);
    fireEvent.click(trigger());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(trigger());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(document.activeElement).toBe(item("Agent"));
  });
});
