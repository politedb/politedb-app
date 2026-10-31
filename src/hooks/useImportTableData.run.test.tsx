import { act, render } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useImportTableData } from "./useImportTableData";
import { seedTabRuntime, resetTabRuntimes } from "src/test/fixtures/tabRuntime";

const mocks = vi.hoisted(() => ({ importCsv: vi.fn() }));
vi.mock("src/lib/system-dialog", () => ({
  openDialog: vi.fn(async () => "/data/users.csv"),
  showMessage: vi.fn(),
}));
vi.mock("src/lib/system-fs", () => ({
  readTextFile: vi.fn(async () => "id\n1\n"),
}));
vi.mock("src/lib/tauri", () => ({
  operationImportCsvTransaction: mocks.importCsv,
}));

let api!: ReturnType<typeof useImportTableData>;
function Harness() {
  api = useImportTableData();
  return null;
}

beforeEach(() => {
  mocks.importCsv.mockReset();
  resetTabRuntimes();
  seedTabRuntime({ tabId: "tab-1", runtimeId: "c1" });
});

describe("runImport", () => {
  it("imports nothing through a connection the tab no longer uses (D3)", async () => {
    seedTabRuntime({ tabId: "tab-1", runtimeId: "c2" });
    render(<Harness />);
    await act(async () => {
      await api.loadDataImport();
    });
    let outcome!: Awaited<ReturnType<typeof api.runImport>>;
    await act(async () => {
      outcome = await api.runImport({
        connectionId: "c1",
        tabId: "tab-1",
        schema: "public",
        tableName: "users",
        columns: [{ name: "id", db_type: "int" }],
        limit: 0,
        offset: 0,
        engine: "postgres" as const,
        onSuccess: async () => {},
      });
    });
    expect(outcome).toEqual({ status: "not-started" });
    expect(mocks.importCsv).not.toHaveBeenCalled();
    expect(api.error).toContain("no longer uses this connection");
  });

  it("runs one import at a time, even for two calls in the same turn", async () => {
    let finish!: () => void;
    mocks.importCsv.mockReturnValue(
      new Promise((resolve) => (finish = () => resolve({ imported: 1 })))
    );
    render(<Harness />);
    await act(async () => {
      await api.loadDataImport();
    });
    const config = {
      connectionId: "c1",
      tabId: "tab-1",
      schema: "public",
      tableName: "users",
      columns: [{ name: "id", db_type: "int" }],
      limit: 0,
      offset: 0,
      engine: "postgres" as const,
      onSuccess: async () => {},
    };
    const first = api.runImport(config);
    const second = api.runImport(config);
    finish();
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(mocks.importCsv).toHaveBeenCalledTimes(1);
  });

  it("keeps the row number and every line of a database error", async () => {
    mocks.importCsv.mockRejectedValue(
      new Error(
        'SQL_TX_STATEMENT_2_FAILED: ERROR: duplicate key value violates unique constraint "users_email_key"\nDETAIL: Key (email)=(a@example.test) already exists.\nHINT: Remove the duplicate.'
      )
    );
    render(<Harness />);
    await act(async () => {
      await api.loadDataImport();
    });
    let outcome!: Awaited<ReturnType<typeof api.runImport>>;
    await act(async () => {
      outcome = await api.runImport({
        connectionId: "c1",
        tabId: "tab-1",
        schema: "public",
        tableName: "users",
        columns: [{ name: "id", db_type: "int" }],
        limit: 0,
        offset: 0,
        engine: "postgres" as const,
        onSuccess: async () => {},
      });
    });
    const expected =
      'Import failed at data row 2: ERROR: duplicate key value violates unique constraint "users_email_key"\nDETAIL: Key (email)=(a@example.test) already exists.\nHINT: Remove the duplicate.';
    expect(outcome).toEqual({ status: "failed", message: expected });
    expect(api.error).toBe(expected);
  });

  it("keeps a single-line and an unnumbered error as they were", async () => {
    render(<Harness />);
    await act(async () => {
      await api.loadDataImport();
    });
    const config = {
      connectionId: "c1",
      tabId: "tab-1",
      schema: "public",
      tableName: "users",
      columns: [{ name: "id", db_type: "int" }],
      limit: 0,
      offset: 0,
      engine: "postgres" as const,
      onSuccess: async () => {},
    };
    mocks.importCsv.mockRejectedValueOnce(
      new Error("SQL_TX_STATEMENT_3_FAILED: value too long")
    );
    await act(async () => {
      await api.runImport(config);
    });
    expect(api.error).toBe("Import failed at data row 3: value too long");
    mocks.importCsv.mockRejectedValueOnce(new Error("connection reset"));
    await act(async () => {
      await api.runImport(config);
    });
    expect(api.error).toBe("connection reset");
  });
});
