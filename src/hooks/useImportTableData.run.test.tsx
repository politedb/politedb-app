import { act, render } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { useImportTableData } from "./useImportTableData";

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

describe("runImport", () => {
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
});
