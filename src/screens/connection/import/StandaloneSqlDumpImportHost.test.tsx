import { render, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";
import { StandaloneSqlDumpImportHost } from "./StandaloneSqlDumpImportHost";

const mocks = vi.hoisted(() => ({
  importSqlDump: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("../hooks/useDatabaseBackup", () => ({
  useDatabaseBackup: () => ({ onImportSqlDump: mocks.importSqlDump }),
}));
vi.mock("./standaloneImport", () => ({
  forgetImportedTableRows: mocks.forget,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const target = {
  requestId: "r1",
  connectionId: "c1",
  engine: "postgres" as const,
  schema: "public",
  tableName: "users",
};

beforeEach(() => {
  mocks.importSqlDump.mockReset().mockResolvedValue(undefined);
  mocks.forget.mockReset();
  useScreenStore.setState({
    profileTabs: [{ id: "t1", isLocked: false } as never],
  });
});

describe("StandaloneSqlDumpImportHost", () => {
  it("runs the dump import once and takes the request over", async () => {
    const onClearTarget = vi.fn();
    render(
      <StandaloneSqlDumpImportHost
        profileScreenId="t1"
        target={target}
        onClearTarget={onClearTarget}
      />
    );
    await waitFor(() => expect(mocks.importSqlDump).toHaveBeenCalledTimes(1));
    expect(onClearTarget).toHaveBeenCalledTimes(1);

    // On success only the originating tab's cached rows are dropped.
    const [onDone, opts] = mocks.importSqlDump.mock.calls[0]!;
    onDone();
    expect(mocks.forget).toHaveBeenCalledWith("t1", {
      schema: "public",
      name: "users",
    });
    expect(opts.canRun()).toBe(true);
  });

  it("refuses to run once the tab is locked", async () => {
    render(
      <StandaloneSqlDumpImportHost
        profileScreenId="t1"
        target={target}
        onClearTarget={vi.fn()}
      />
    );
    await waitFor(() => expect(mocks.importSqlDump).toHaveBeenCalled());
    useScreenStore.setState({
      profileTabs: [{ id: "t1", isLocked: true } as never],
    });
    expect(mocks.importSqlDump.mock.calls[0]![1].canRun()).toBe(false);
  });
});
