import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { ExportColumnEditor } from "./ExportColumnEditor";
import {
  buildDefaultMaskedPolicy,
  withColumnRule,
} from "src/lib/export-masking";

const columns = ["id", "email", "note", "created_at", "name", "role"];

describe("ExportColumnEditor", () => {
  it("renders column list with treatments and Preview by default (Keep)", () => {
    const policy = buildDefaultMaskedPolicy(columns);
    render(
      <ExportColumnEditor
        columnNames={columns}
        selectedColumns={columns}
        policy={policy}
        selectedCount={columns.length}
        outputCount={columns.length}
        onToggleColumn={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onRuleChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText("Search columns")).toBeTruthy();
    expect(
      screen.getByLabelText(`Select all ${columns.length} columns`)
    ).toBeTruthy();
    const selectAll = screen.getByLabelText(
      `Select all ${columns.length} columns`
    ) as HTMLInputElement;
    expect(selectAll.checked).toBe(true);
    expect(screen.getByText("Treatment")).toBeTruthy();
    expect(screen.getByTitle("Synthetic preview — not live data")).toBeTruthy();
    expect(screen.getByText("Masking & null export notes")).toBeTruthy();
    for (const name of columns) {
      expect(screen.getByLabelText(`Include column ${name}`)).toBeTruthy();
      const treatment = screen.getByLabelText(
        `Treatment for ${name}`
      ) as HTMLSelectElement;
      expect(treatment.value).toBe("keep");
    }
  });

  it("shows synthetic Keep preview by default and Redact when chosen", () => {
    let policy = buildDefaultMaskedPolicy(columns);
    policy = withColumnRule(policy, "email", "redact");
    render(
      <ExportColumnEditor
        columnNames={columns}
        selectedColumns={columns}
        policy={policy}
        selectedCount={columns.length}
        outputCount={columns.length}
        onToggleColumn={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onRuleChange={vi.fn()}
      />
    );

    expect(screen.getByText("Treatment")).toBeTruthy();
    expect(screen.getByTitle("Synthetic preview — not live data")).toBeTruthy();
    expect(screen.getByLabelText("Treatment for email")).toBeTruthy();
    expect(screen.getAllByText("[REDACTED]").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ORIGINAL_VALUE").length).toBeGreaterThan(0);
  });

  it("keeps unchecked columns visible with disabled treatment", () => {
    const policy = buildDefaultMaskedPolicy(["id", "email"]);
    render(
      <ExportColumnEditor
        columnNames={columns}
        selectedColumns={["id", "email"]}
        policy={policy}
        selectedCount={2}
        outputCount={2}
        onToggleColumn={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onRuleChange={vi.fn()}
      />
    );

    const noteBox = screen.getByLabelText(
      "Include column note"
    ) as HTMLInputElement;
    expect(noteBox.checked).toBe(false);
    const noteTreatment = screen.getByLabelText(
      "Treatment for note"
    ) as HTMLSelectElement;
    expect(noteTreatment.disabled).toBe(true);
  });

  it("filters by search without calling selection handlers", () => {
    const onToggleColumn = vi.fn();
    const onToggleSelectAll = vi.fn();
    render(
      <ExportColumnEditor
        columnNames={columns}
        selectedColumns={columns}
        policy={buildDefaultMaskedPolicy(columns)}
        selectedCount={columns.length}
        outputCount={columns.length}
        onToggleColumn={onToggleColumn}
        onToggleSelectAll={onToggleSelectAll}
        onRuleChange={vi.fn()}
      />
    );

    fireEvent.input(screen.getByLabelText("Search columns"), {
      target: { value: "email" },
    });
    expect(screen.getByLabelText("Include column email")).toBeTruthy();
    expect(screen.queryByLabelText("Include column note")).toBeNull();
    expect(onToggleColumn).not.toHaveBeenCalled();
    expect(onToggleSelectAll).not.toHaveBeenCalled();
  });

  it("select-all control invokes handler for full column set", () => {
    const onToggleSelectAll = vi.fn();
    render(
      <ExportColumnEditor
        columnNames={columns}
        selectedColumns={["id"]}
        policy={buildDefaultMaskedPolicy(["id"])}
        selectedCount={1}
        outputCount={1}
        onToggleColumn={vi.fn()}
        onToggleSelectAll={onToggleSelectAll}
        onRuleChange={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByLabelText(`Select all ${columns.length} columns`)
    );
    expect(onToggleSelectAll).toHaveBeenCalledTimes(1);
  });

  it("marks keep-original rows with amber indicator; internal omit still previews as omitted", () => {
    let policy = buildDefaultMaskedPolicy(["email", "note"]);
    policy = withColumnRule(policy, "email", "keep");
    policy = withColumnRule(policy, "note", "omit");

    const { container } = render(
      <ExportColumnEditor
        columnNames={["email", "note"]}
        selectedColumns={["email", "note"]}
        policy={policy}
        selectedCount={2}
        outputCount={1}
        onToggleColumn={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onRuleChange={vi.fn()}
      />
    );

    expect(container.querySelector('[title="Keep original"]')).toBeTruthy();
    // Internal omit compatibility: selected+omit still shows synthetic omitted preview
    expect(screen.getByText("(omitted)")).toBeTruthy();
  });

  it("expanded Preview disclosure stays in the fixed-height grid row", () => {
    const policy = buildDefaultMaskedPolicy(["email", "note"]);
    const { container } = render(
      <ExportColumnEditor
        columnNames={["email", "note"]}
        selectedColumns={["email", "note"]}
        policy={policy}
        selectedCount={2}
        outputCount={2}
        onToggleColumn={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onRuleChange={vi.fn()}
      />
    );

    const rows = Array.from(
      container.querySelectorAll('[aria-label^="Include column"]')
    ).map((input) => input.closest(".grid"));
    for (const row of rows) {
      expect(row).toBeTruthy();
      expect(row!.className).toMatch(/(?:^|\s)h-10(?:\s|$)/);
    }

    const previewBtn = screen.getAllByRole("button", { name: "Preview" })[0];
    fireEvent.click(previewBtn);
    expect(screen.getByText(/Synthetic:/)).toBeTruthy();
    // Expanded disclosure remains inside the same fixed-height grid row
    const openRow = previewBtn.closest(".grid");
    expect(openRow!.className).toMatch(/(?:^|\s)h-10(?:\s|$)/);
    expect(openRow!.textContent).toMatch(/Synthetic:/);
  });

  it("does not include Omit in the treatment menu", () => {
    const policy = buildDefaultMaskedPolicy(["email"]);
    render(
      <ExportColumnEditor
        columnNames={["email"]}
        selectedColumns={["email"]}
        policy={policy}
        selectedCount={1}
        outputCount={1}
        onToggleColumn={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onRuleChange={vi.fn()}
      />
    );
    const treatment = screen.getByLabelText(
      "Treatment for email"
    ) as HTMLSelectElement;
    const labels = Array.from(treatment.options).map((o) => o.textContent);
    expect(labels).toEqual(["Keep original", "Redact", "Set null"]);
    expect(screen.queryByRole("option", { name: "Omit" })).toBeNull();
  });

  it("shows masking notes tooltip above the trigger on hover", async () => {
    vi.useFakeTimers();
    const policy = buildDefaultMaskedPolicy(columns);
    render(
      <ExportColumnEditor
        columnNames={columns}
        selectedColumns={columns}
        policy={policy}
        selectedCount={columns.length}
        outputCount={columns.length}
        onToggleColumn={vi.fn()}
        onToggleSelectAll={vi.fn()}
        onRuleChange={vi.fn()}
      />
    );

    const trigger = screen.getByText("Masking & null export notes");
    const note = /Masking reduces data exposure/;
    expect(screen.queryByText(note)).toBeNull();

    // mouseEnter does not bubble — fire on Tooltip wrapper
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement);
    await vi.advanceTimersByTimeAsync(200);

    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toMatch(note);
    expect(tip.className).toMatch(/bottom-full/);

    fireEvent.mouseLeave(trigger.parentElement as HTMLElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
    vi.useRealTimers();
  });
});
