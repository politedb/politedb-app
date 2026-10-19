import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";
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

function openMenu() {
  fireEvent.click(screen.getByLabelText("Assistant mode"));
}

beforeEach(() => {
  localStorage.clear();
  useProUpgradeStore.setState({ feature: null });
});

afterEach(() => cleanup());

describe("AssistantModePicker", () => {
  it("defaults to Agent with Pro and switches to Manual", () => {
    setPro(true);
    render(<AssistantModePicker />);
    expect(screen.getByLabelText("Assistant mode").textContent).toContain(
      "Agent"
    );
    openMenu();
    expect(screen.getByText("Mode")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Manual"));
    expect(localStorage.getItem("politedb.ai.mode")).toBe("manual");
    expect(screen.getByLabelText("Assistant mode").textContent).toContain(
      "Manual"
    );
  });

  it("shows Manual without Pro, and Agent opens the upgrade dialog", () => {
    setPro(false);
    render(<AssistantModePicker />);
    expect(screen.getByLabelText("Assistant mode").textContent).toContain(
      "Manual"
    );
    openMenu();
    fireEvent.click(screen.getByText("Agent"));
    expect(useProUpgradeStore.getState().feature).toBe("ai-agent");
    expect(localStorage.getItem("politedb.ai.mode")).toBeNull();
  });
});
