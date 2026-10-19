import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";
import {
  getAssistantMode,
  resetAssistantModeForTests,
} from "src/lib/ai-assistant/assistantMode";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import { AssistantModePicker } from "./AssistantModePicker";

vi.mock("src/components/common/Popover", () => ({
  Popover: ({ children, content, open }: any) => (
    <div>
      {children}
      {open ? content : null}
    </div>
  ),
}));

function setPro(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

const trigger = () => screen.getByRole("button", { name: /Assistant mode/ });
const item = (name: string) =>
  screen.getByRole("menuitemradio", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  localStorage.clear();
  resetAssistantModeForTests();
  useProUpgradeStore.setState({ feature: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AssistantModePicker", () => {
  it("defaults to Agent with Pro and switches to Manual", () => {
    setPro(true);
    render(<AssistantModePicker />);
    expect(trigger().getAttribute("aria-label")).toBe("Assistant mode: Agent");
    fireEvent.click(trigger());
    fireEvent.click(item("Manual"));
    expect(localStorage.getItem("politedb.ai.mode")).toBe("manual");
    expect(getAssistantMode()).toBe("manual");
    expect(trigger().getAttribute("aria-label")).toBe("Assistant mode: Manual");
  });

  it("shows Manual without Pro, and Agent opens the upgrade dialog", () => {
    setPro(false);
    render(<AssistantModePicker />);
    expect(trigger().textContent).toContain("Manual");
    fireEvent.click(trigger());
    fireEvent.click(item("Agent"));
    expect(useProUpgradeStore.getState().feature).toBe("ai-agent");
    expect(localStorage.getItem("politedb.ai.mode")).toBeNull();
  });

  it("keeps the chosen mode for the session when storage cannot be written", () => {
    setPro(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(<AssistantModePicker />);
    fireEvent.click(trigger());
    fireEvent.click(item("Manual"));
    // What submission reads matches what the picker shows.
    expect(getAssistantMode()).toBe("manual");
    expect(trigger().getAttribute("aria-label")).toBe("Assistant mode: Manual");
  });

  it("exposes the menu state and the selected mode", () => {
    setPro(true);
    render(<AssistantModePicker />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(
      screen.getByRole("menu").id
    );
    expect(item("Agent").getAttribute("aria-checked")).toBe("true");
    expect(item("Manual").getAttribute("aria-checked")).toBe("false");
    // Focus starts on the selected mode.
    expect(document.activeElement).toBe(item("Agent"));
  });

  it("moves with arrow keys and closes on Escape, returning focus", () => {
    setPro(true);
    render(<AssistantModePicker />);
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Manual"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Agent"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(getAssistantMode()).toBe("agent");
  });
});
