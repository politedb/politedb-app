import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/preact";
import { ExportTableDialog } from "./ExportTableDialog";
import {
  buildDefaultMaskedPolicy,
  withColumnRule,
} from "src/lib/exportMasking";

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
  return render(
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

describe("ExportTableDialog UX", () => {
  beforeEach(() => {
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
    // Scope is conveyed via title tooltip, not as visible subtitle text
    const identity = container.querySelector(
      '[title="public.users · All rows"]'
    );
    expect(identity).toBeTruthy();
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
    const identity = container.querySelector(
      '[title="public.users · Current page"]'
    );
    expect(identity).toBeTruthy();
    expect(screen.getByText(".csv")).toBeTruthy();
  });

  it("always shows per-column treatments defaulting to Keep", () => {
    renderDialog();
    expect(screen.queryByText("Mask sensitive values")).toBeNull();
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

    const exportBtn = screen.getByRole("button", { name: /Export CSV/i });
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
      name: /Export CSV/i,
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

  it("shows indeterminate progress for unknown total without 0/0", () => {
    hookState.progress = { exported: 7 };
    hookState.exporting = true;
    renderDialog({ totalRows: null });
    expect(screen.getByText("7 rows")).toBeTruthy();
    expect(screen.queryByText(/7 \/ /)).toBeNull();
    expect(screen.queryByText("0 / 0 rows")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("marks unknown-total export completed by settlement not row math", () => {
    hookState.progress = { exported: 3 };
    hookState.exporting = false;
    renderDialog({ totalRows: null });
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByText("Completed!")).toBeTruthy();
  });
});
