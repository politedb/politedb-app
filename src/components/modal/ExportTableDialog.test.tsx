import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { ExportTableDialog } from "./ExportTableDialog";
import {
  buildDefaultMaskedPolicy,
  withColumnRule,
} from "src/lib/export-masking";
import { useLicenseStore } from "src/stores/license";
import type { LicenseState } from "src/lib/tauri/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";

const hookState = {
  format: "csv" as const,
  exporting: false,
  progress: null as null | {
    exported: number;
    error?: string;
    warning?: string;
    truncated?: boolean;
  },
  exportOptions: {
    format: "csv" as const,
    fileName: "users",
    columns: ["id", "email", "note", "a", "b", "c"],
    csvOptions: {},
    nullToEmpty: true,
    masked: true,
    maskingPolicy: buildDefaultMaskedPolicy([
      "id",
      "email",
      "note",
      "a",
      "b",
      "c",
    ]) as ReturnType<typeof buildDefaultMaskedPolicy> | null,
  },
  setExportOptions: vi.fn(),
  setFileName: vi.fn(),
  setProgress: vi.fn(),
  handleChangeFormat: vi.fn(),
  handleExport: vi.fn(),
  loadExportOptions: vi.fn(),
  setMaskedMode: vi.fn(),
  setMaskingPolicy: vi.fn(),
  clearMaskState: vi.fn(),
  requestCancel: vi.fn(),
};

vi.mock("src/hooks/useExportTableData", () => ({
  useExportTableData: () => hookState,
}));

const showMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("src/lib/system-dialog", () => ({
  showMessage: (...args: unknown[]) => showMessage(...args),
}));

const columns = [
  { name: "id", db_type: "int" },
  { name: "email", db_type: "text" },
  { name: "note", db_type: "text" },
  { name: "a", db_type: "text" },
  { name: "b", db_type: "text" },
  { name: "c", db_type: "text" },
];

function renderDialog(
  overrides: Partial<Parameters<typeof ExportTableDialog>[0]> = {}
) {
  return render(dialogElement(overrides));
}

function dialogElement(
  overrides: Partial<Parameters<typeof ExportTableDialog>[0]> = {}
) {
  return (
    <ExportTableDialog
      open
      handleClose={vi.fn()}
      connectionId="c1"
      schema="public"
      tableName="users"
      columns={columns}
      appliedFilters={[]}
      appliedFilterCombine="AND"
      totalRows={10}
      {...overrides}
    />
  );
}

/** Turns on "Mask sensitive columns", which reveals the per-column treatments. */
function enableMasking() {
  fireEvent.click(screen.getByLabelText("Mask sensitive columns"));
}

describe("ExportTableDialog UX", () => {
  beforeEach(() => {
    showMessage.mockClear();
    useLicenseStore.setState({ state: { pro_access: true } as LicenseState });
    hookState.format = "csv";
    hookState.exporting = false;
    hookState.progress = null;
    hookState.exportOptions = {
      format: "csv",
      fileName: "users",
      columns: ["id", "email", "note", "a", "b", "c"],
      csvOptions: {},
      nullToEmpty: true,
      masked: true,
      maskingPolicy: buildDefaultMaskedPolicy([
        "id",
        "email",
        "note",
        "a",
        "b",
        "c",
      ]),
    };
    vi.clearAllMocks();
    showMessage.mockReset();
    showMessage.mockResolvedValue(undefined);
    // Functional updater support for selection changes in the dialog
    hookState.setExportOptions.mockImplementation((updater: unknown) => {
      if (typeof updater === "function") {
        hookState.exportOptions = (
          updater as (
            prev: typeof hookState.exportOptions
          ) => typeof hookState.exportOptions
        )(hookState.exportOptions);
      } else if (updater && typeof updater === "object") {
        hookState.exportOptions = {
          ...hookState.exportOptions,
          ...(updater as typeof hookState.exportOptions),
        };
      }
    });
  });

  it("shows Export data header with table identity and scope", () => {
    const { container } = renderDialog();
    expect(screen.getByText("Export data")).toBeTruthy();
    expect(screen.getByText("public.users")).toBeTruthy();
    // The scope is visible, with the row count when known.
    expect(
      container.querySelector('[title="public.users · All rows · 10 rows"]')
    ).toBeTruthy();
    expect(screen.getByText("All rows · 10 rows")).toBeTruthy();
  });

  it("applies default Dialog max width (max-w-xl) on the outer wrapper", () => {
    const { container } = renderDialog();
    const outer = container.querySelector(".relative.mx-auto.w-full");
    expect(outer).toBeTruthy();
    expect(outer!.className).toMatch(/max-w-xl\b/);
  });

  it("shows current page scope and format suffix", () => {
    const { container } = renderDialog({
      pagination: { limit: 50, offset: 0 },
    });
    expect(screen.getByText("Current page · 10 rows")).toBeTruthy();
    expect(
      container.querySelector('[title="public.users · Current page · 10 rows"]')
    ).toBeTruthy();
    expect(screen.getByText(".csv")).toBeTruthy();
  });

  it("is a plain column picker until masking is turned on", () => {
    renderDialog();
    expect(screen.getByLabelText("Include column email")).toBeTruthy();
    expect(screen.queryByText("Treatment")).toBeNull();
    expect(screen.queryByText(/kept original/)).toBeNull();
    expect(
      (screen.getByLabelText("Mask sensitive columns") as HTMLInputElement)
        .checked
    ).toBe(false);
  });

  it("asks Free users to upgrade instead of turning masking on", () => {
    useLicenseStore.setState({ state: { pro_access: false } as LicenseState });
    useProUpgradeStore.setState({ feature: null });
    renderDialog();
    enableMasking();
    expect(useProUpgradeStore.getState().feature).toBe("export-masking");
    expect(screen.queryByText("Treatment")).toBeNull();
    // The refused click must not leave the box ticked.
    expect(
      (screen.getByLabelText("Mask sensitive columns") as HTMLInputElement)
        .checked
    ).toBe(false);
  });

  it("turning masking off resets every rule to Keep", () => {
    hookState.exportOptions = {
      ...hookState.exportOptions,
      maskingPolicy: withColumnRule(
        hookState.exportOptions.maskingPolicy!,
        "email",
        "redact"
      ),
    };
    renderDialog();
    enableMasking();
    expect(
      (screen.getByLabelText("Treatment for email") as HTMLSelectElement).value
    ).toBe("redact");
    enableMasking();
    expect(hookState.exportOptions.maskingPolicy?.rulesByColumn.email).toBe(
      "keep"
    );
    expect(
      Object.values(hookState.exportOptions.maskingPolicy!.rulesByColumn)
    ).toEqual(Array(6).fill("keep"));
  });

  it("shows per-column treatments defaulting to Keep once masking is on", () => {
    renderDialog();
    enableMasking();
    expect(screen.getByText("Treatment")).toBeTruthy();
    const treatment = screen.getByLabelText(
      "Treatment for email"
    ) as HTMLSelectElement;
    expect(treatment.value).toBe("keep");
    expect(screen.getByRole("option", { name: /SQL/i })).toBeTruthy();
    const sql = screen.getByRole("option", {
      name: /^SQL$/i,
    }) as HTMLOptionElement;
    expect(sql.disabled).toBe(false);
  });

  it("disables SQL when masking is applied and blocks zero-output export", () => {
    const policy = withColumnRule(
      withColumnRule(buildDefaultMaskedPolicy(["id", "email"]), "id", "omit"),
      "email",
      "omit"
    );
    hookState.exportOptions = {
      ...hookState.exportOptions,
      masked: true,
      columns: ["id", "email"],
      maskingPolicy: policy,
      format: "csv",
    };
    hookState.format = "csv";
    renderDialog();

    const sql = screen.getByRole("option", {
      name: /SQL/i,
    }) as HTMLOptionElement;
    expect(sql.disabled).toBe(true);

    const exportBtn = screen.getByRole("button", { name: "Export" });
    expect((exportBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/0 \/ 6 output columns/)).toBeTruthy();
  });

  it("does not render empty masked selection as all selected", () => {
    hookState.exportOptions = {
      ...hookState.exportOptions,
      masked: true,
      columns: [],
      maskingPolicy: buildDefaultMaskedPolicy([]),
    };
    renderDialog();

    const idBox = screen.getByLabelText(
      "Include column id"
    ) as HTMLInputElement;
    expect(idBox.checked).toBe(false);
    const selectAll = screen.getByLabelText(
      "Select all 6 columns"
    ) as HTMLInputElement;
    expect(selectAll.checked).toBe(false);
  });

  it("shows compact kept-original warning when some columns stay Keep under masking", () => {
    let policy = buildDefaultMaskedPolicy(["id", "email", "note"]);
    policy = withColumnRule(policy, "id", "redact");
    policy = withColumnRule(policy, "note", "set_null");
    // email remains Keep
    hookState.exportOptions = {
      ...hookState.exportOptions,
      masked: true,
      columns: ["id", "email", "note"],
      maskingPolicy: policy,
    };
    renderDialog();
    enableMasking();
    expect(screen.getByText(/1 kept original/)).toBeTruthy();
    expect(screen.getByText(/may contain sensitive data/)).toBeTruthy();
  });

  it("replaces editable body with progress and keeps Cancel", () => {
    hookState.progress = { exported: 3 };
    hookState.exporting = true;
    renderDialog();
    expect(screen.queryByLabelText("Search columns")).toBeNull();
    expect(screen.getByText(/3 \/ 10 rows/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Export/i })).toBeNull();
  });

  it("Cancel during export requests cancellation", () => {
    hookState.progress = { exported: 1 };
    hookState.exporting = true;
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hookState.requestCancel).toHaveBeenCalled();
  });

  it("does not offer Omit in treatment options", () => {
    hookState.exportOptions = {
      ...hookState.exportOptions,
      masked: true,
      columns: ["id", "email"],
      maskingPolicy: buildDefaultMaskedPolicy(["id", "email"]),
    };
    renderDialog();
    enableMasking();
    const treatment = screen.getByLabelText(
      "Treatment for id"
    ) as HTMLSelectElement;
    const labels = Array.from(treatment.options).map((o) => o.textContent);
    expect(labels).toEqual(["Keep original", "Redact", "Set null"]);
    expect(labels).not.toContain("Omit");
  });

  it("blocks export when zero columns are selected", () => {
    hookState.exportOptions = {
      ...hookState.exportOptions,
      masked: true,
      columns: [],
      maskingPolicy: buildDefaultMaskedPolicy([]),
    };
    renderDialog();
    const exportBtn = screen.getByRole("button", {
      name: "Export",
    }) as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);
    expect(screen.getByText(/0 \/ 6 output columns/)).toBeTruthy();
    const selectAll = screen.getByLabelText(
      "Select all 6 columns"
    ) as HTMLInputElement;
    expect(selectAll.checked).toBe(false);
  });

  it("excludes unchecked columns from output count", () => {
    // Only id + email selected; note and others unchecked → 2 output columns
    hookState.exportOptions = {
      ...hookState.exportOptions,
      masked: true,
      columns: ["id", "email"],
      maskingPolicy: buildDefaultMaskedPolicy(["id", "email"]),
    };
    renderDialog();
    expect(screen.getByText(/2 \/ 6 output columns/)).toBeTruthy();
    const idBox = screen.getByLabelText(
      "Include column id"
    ) as HTMLInputElement;
    const emailBox = screen.getByLabelText(
      "Include column email"
    ) as HTMLInputElement;
    expect(idBox.checked).toBe(true);
    expect(emailBox.checked).toBe(true);
    const noteBox = screen.getByLabelText(
      "Include column note"
    ) as HTMLInputElement;
    expect(noteBox.checked).toBe(false);
  });

  it("does not fake a percentage when the total is unknown", () => {
    hookState.progress = { exported: 18000 };
    hookState.exporting = true;
    renderDialog({ totalRows: null });
    expect(screen.getByText("18,000 rows")).toBeTruthy();
    expect(screen.queryByText(/18000 \/ /)).toBeNull();
    const bar = screen.getByRole("progressbar");
    expect(bar.style.width).toBe("0%");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  it("fills an unknown-total export only when the pipeline settles", () => {
    hookState.progress = { exported: 18000 };
    hookState.exporting = false;
    renderDialog({ totalRows: null });
    const bar = screen.getByRole("progressbar");
    expect(bar.style.width).toBe("100%");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });

  it("scales a known total from 0% with rows written", () => {
    hookState.progress = { exported: 0 };
    hookState.exporting = true;
    const view = renderDialog({ totalRows: 18000 });
    const bar = screen.getByRole("progressbar");
    expect(bar.style.width).toBe("0%");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    view.unmount();

    hookState.progress = { exported: 7200 };
    hookState.exporting = true;
    renderDialog({ totalRows: 18000 });
    const mid = screen.getByRole("progressbar");
    expect(mid.style.width).toBe("40%");
    expect(screen.getByText("7,200 / 18,000 rows")).toBeTruthy();
  });

  it("closes quietly once a cancelled export settles", async () => {
    const handleClose = vi.fn();
    hookState.progress = { exported: 12, error: "Export cancelled" };
    hookState.exporting = false;
    renderDialog({ handleClose, totalRows: null });
    await waitFor(() => expect(handleClose).toHaveBeenCalled());
    expect(showMessage).not.toHaveBeenCalled();
    expect(hookState.setProgress).toHaveBeenCalledWith(null);
    expect(hookState.clearMaskState).toHaveBeenCalled();
  });

  it("keeps the dialog open with the reason when an export fails", async () => {
    const handleClose = vi.fn();
    hookState.progress = { exported: 0, error: "Disk full" };
    hookState.exporting = false;
    renderDialog({ handleClose });
    await waitFor(() =>
      expect(hookState.setProgress).toHaveBeenCalledWith(null)
    );
    expect(handleClose).not.toHaveBeenCalled();
    expect(showMessage).not.toHaveBeenCalled();
  });

  it("shows the failure above the settings, ready to retry", async () => {
    const view = renderDialog();
    hookState.progress = { exported: 0, error: "Disk full" };
    hookState.exporting = false;
    view.rerender(dialogElement());
    hookState.progress = null;
    view.rerender(dialogElement());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Disk full")
    );
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("marks unknown-total export completed by settlement not row math", () => {
    hookState.progress = { exported: 3 };
    hookState.exporting = false;
    renderDialog({ totalRows: null });
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByText("Completed!")).toBeTruthy();
  });
});
