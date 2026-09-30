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
    masked: false,
    maskingPolicy: null as ReturnType<typeof buildDefaultMaskedPolicy> | null,
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
      masked: false,
      maskingPolicy: null,
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

  it("enables masked mode via toggle", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Mask sensitive values"));
    expect(hookState.setMaskedMode).toHaveBeenCalledWith(
      true,
      expect.arrayContaining(["id", "email"])
    );
  });

  it("disables SQL option and export when masked with zero output", () => {
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
    expect(screen.getByText(/0 output column/)).toBeTruthy();
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
    expect(screen.getByText(/0 of 6 selected/)).toBeTruthy();
  });

  it("shows compact kept-original warning in footer", () => {
    let policy = buildDefaultMaskedPolicy(["id", "email", "note"]);
    policy = withColumnRule(policy, "email", "keep");
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

  it("does not offer Omit in treatment options when masked", () => {
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
    expect(labels).toEqual(["Redact", "Set null", "Keep original"]);
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
    expect(screen.getByText(/0 output column/)).toBeTruthy();
    expect(screen.getByText(/0 of 6 selected/)).toBeTruthy();
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
    expect(screen.getByText(/2 output columns/)).toBeTruthy();
    expect(screen.getByText(/2 of 6 selected/)).toBeTruthy();
    const noteBox = screen.getByLabelText(
      "Include column note"
    ) as HTMLInputElement;
    expect(noteBox.checked).toBe(false);
  });
});
