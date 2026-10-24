import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  saveDialog: vi.fn(),
  showMessage: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("src/lib/system-dialog", () => ({
  saveDialog: io.saveDialog,
  showMessage: io.showMessage,
}));
vi.mock("src/lib/system-fs", () => ({ writeTextFile: io.writeTextFile }));
vi.mock("src/components/common/Popover", () => ({
  Popover: ({ children, content, open }: any) => (
    <div>
      {children}
      {open ? content : null}
    </div>
  ),
}));

import {
  SqlResultSummary,
  describeResult,
  formatElapsed,
} from "./SqlResultSummary";

const columns = [
  { name: "id", db_type: "int" },
  { name: "name", db_type: "text" },
] as any;
const rows = [
  [1, "Ada"],
  [2, "Linus"],
];

beforeEach(() => {
  io.saveDialog.mockReset();
  io.showMessage.mockReset();
  io.writeTextFile.mockReset();
});

describe("describeResult and formatElapsed", () => {
  it("say what a statement returned and how long it ran", () => {
    expect(describeResult({ columns: 0, rows: 0 })).toBe("Statement completed");
    expect(describeResult({ columns: 2, rows: 1 })).toBe("1 row");
    expect(describeResult({ columns: 2, rows: 50000, truncated: true })).toBe(
      "50,000 rows (stopped at the row limit; narrow the query to see the rest)"
    );
    expect(formatElapsed(35)).toBe("35 ms");
    expect(formatElapsed(1250)).toBe("1.3 s");
    expect(formatElapsed(125_000)).toBe("2 min 5 s");
    expect(formatElapsed(undefined)).toBe("");
  });
});

describe("SqlResultSummary", () => {
  function renderSummary() {
    render(
      <SqlResultSummary
        columns={columns}
        rowCount={rows.length}
        getRow={(i) => rows[i]}
        elapsedMs={42}
      />
    );
  }

  it("shows the rows and time, and exports CSV with a header", async () => {
    io.saveDialog.mockResolvedValue("/tmp/result.csv");
    io.writeTextFile.mockResolvedValue(undefined);
    renderSummary();
    expect(screen.getByRole("status")).toHaveTextContent("2 rows · 42 ms");

    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    await waitFor(() => expect(io.writeTextFile).toHaveBeenCalled());
    expect(io.writeTextFile.mock.calls[0][0]).toBe("/tmp/result.csv");
    expect(io.writeTextFile.mock.calls[0][1]).toBe("id,name\n1,Ada\n2,Linus");
  });

  it("says when the export could not be written", async () => {
    io.saveDialog.mockResolvedValue("/tmp/result.json");
    io.writeTextFile.mockRejectedValue(new Error("denied"));
    renderSummary();
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(io.showMessage).toHaveBeenCalled());
    expect(io.showMessage.mock.calls[0][1]).toMatchObject({ kind: "error" });
  });

  it("says when the save dialog itself fails", async () => {
    io.saveDialog.mockRejectedValue(new Error("dialog unavailable"));
    renderSummary();
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));
    await waitFor(() => expect(io.showMessage).toHaveBeenCalled());
    expect(io.writeTextFile).not.toHaveBeenCalled();
  });

  it("keeps every column of duplicate names in JSON", async () => {
    io.saveDialog.mockResolvedValue("/tmp/result.json");
    io.writeTextFile.mockResolvedValue(undefined);
    render(
      <SqlResultSummary
        columns={
          [
            { name: "id", db_type: "int" },
            { name: "id", db_type: "int" },
            { name: "id_2", db_type: "int" },
          ] as any
        }
        rowCount={1}
        getRow={() => [1, 2, 3]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(io.writeTextFile).toHaveBeenCalled());
    expect(JSON.parse(io.writeTextFile.mock.calls[0][1])).toEqual([
      { id: "1", id_3: "2", id_2: "3" },
    ]);
  });

  it("offers no export without rows", () => {
    render(
      <SqlResultSummary columns={[]} rowCount={0} getRow={() => undefined} />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Statement completed");
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
  });
});
