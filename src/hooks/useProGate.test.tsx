import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/preact";
import { useProGate } from "./useProGate";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import type { LicenseState } from "src/lib/tauri/license";
import { hasProAccess } from "src/lib/license/proAccess";

function setProAccess(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

function Probe(props: { onRun: () => void }) {
  const { hasPro, requirePro } = useProGate();
  return (
    <button
      type="button"
      onClick={() => {
        if (requirePro("backup-restore")) props.onRun();
      }}
    >
      {hasPro ? "pro" : "free"}
    </button>
  );
}

describe("useProGate", () => {
  beforeEach(() => {
    useProUpgradeStore.setState({ feature: null });
  });

  it("runs the action with Pro access", () => {
    setProAccess(true);
    let runs = 0;
    render(<Probe onRun={() => runs++} />);
    fireEvent.click(screen.getByRole("button"));
    expect(runs).toBe(1);
    expect(useProUpgradeStore.getState().feature).toBeNull();
  });

  it("opens the upgrade dialog instead of running without Pro", () => {
    setProAccess(false);
    let runs = 0;
    render(<Probe onRun={() => runs++} />);
    fireEvent.click(screen.getByRole("button"));
    expect(runs).toBe(0);
    expect(useProUpgradeStore.getState().feature).toBe("backup-restore");
  });

  it("follows license changes such as activating a key", () => {
    setProAccess(false);
    render(<Probe onRun={() => {}} />);
    expect(screen.getByRole("button").textContent).toBe("free");
    act(() => setProAccess(true));
    expect(screen.getByRole("button").textContent).toBe("pro");
  });
});

describe("hasProAccess", () => {
  it("trusts pro_access in flavors that gate Pro features", () => {
    const gated = { gatesProFeatures: true };
    expect(hasProAccess({ pro_access: true }, gated)).toBe(true);
    expect(hasProAccess({ pro_access: false }, gated)).toBe(false);
    expect(hasProAccess(null, gated)).toBe(false);
  });

  it("unlocks everything where Pro features are not gated", () => {
    expect(hasProAccess(null, { gatesProFeatures: false })).toBe(true);
  });
});
