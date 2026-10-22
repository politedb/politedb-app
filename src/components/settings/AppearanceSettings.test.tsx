import { h } from "preact";
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import type { AppSettings } from "./types";

const settings: AppSettings = {
  theme: "dark",
  uiFont: "georgia",
  density: "comfortable",
  defaultRowLimit: "300",
  queryTimeoutSeconds: "30",
  autosaveSqlDrafts: true,
  autoConnectLastProfile: false,
  healthCheckInterval: "off",
};

function setup() {
  const update = vi.fn();
  render(h(AppearanceSettings, { settings, update }));
  return update;
}

describe("AppearanceSettings", () => {
  it("picks the theme from preview tiles with native radios", () => {
    const update = setup();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];

    expect(radios.map((r) => r.value)).toEqual(["system", "light", "dark"]);
    expect(radios.find((r) => r.checked)?.value).toBe("dark");

    fireEvent.click(within(group).getByLabelText("Light"));
    expect(update).toHaveBeenCalledWith("theme", "light");
  });

  it("groups the fonts and shows each in its own face", () => {
    setup();
    const select = screen.getByRole("combobox", { name: "Application font" });
    const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["Default", "Other fonts"]);
    // No fake separator option any more.
    expect(select.querySelector("option[disabled]")).toBeNull();
    // Each font is listed in its own face where the platform allows it.
    const georgia = [...select.querySelectorAll("option")].find(
      (o) => o.value === "georgia"
    ) as HTMLOptionElement;
    expect(georgia.style.fontFamily).toContain("Georgia");
  });

  it("explains the settings in plain words", () => {
    setup();
    expect(
      screen.getByText("Follow your system, or always use light or dark.")
    ).toBeTruthy();
    expect(screen.getByText(/The SQL editor keeps its own font/)).toBeTruthy();
    expect(screen.queryByText("Portable font stacks.")).toBeNull();
  });
});
