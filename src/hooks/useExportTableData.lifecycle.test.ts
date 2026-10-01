import { h } from "preact";
import { useEffect } from "preact/hooks";
import { act, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExportTableData } from "./useExportTableData";
import type { ExportConfig } from "src/lib/exportPipeline";

const mocks = vi.hoisted(() => ({
  saveDialog: vi.fn(),
  runStreamingExport: vi.fn(),
}));

vi.mock("src/lib/system-dialog", () => ({
  saveDialog: (...args: unknown[]) => mocks.saveDialog(...args),
}));

vi.mock("src/lib/exportPipeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/lib/exportPipeline")>();
  return {
    ...actual,
    runStreamingExport: (...args: unknown[]) =>
      mocks.runStreamingExport(...args),
  };
});

const columns = [
  { name: "id", db_type: "int" },
  { name: "email", db_type: "text" },
];

const config: ExportConfig = {
  connectionId: "c1",
  schema: "public",
  tableName: "users",
  columns,
  appliedFilters: [],
  appliedFilterCombine: "AND",
};

type Api = ReturnType<typeof useExportTableData>;

function Harness({
  onReady,
  autoLoad = true,
}: {
  onReady: (api: Api) => void;
  autoLoad?: boolean;
}) {
  const api = useExportTableData();
  const apiRef = { current: api };
  apiRef.current = api;
  useEffect(() => {
    onReady(apiRef.current);
  });
  useEffect(() => {
    if (!autoLoad) return;
    void apiRef.current.loadExportOptions(columns, "users");
    // Intentionally once on mount; avoid cancelling mid-export on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad]);
  return h("div", {
    "data-exporting": String(api.exporting),
    "data-error": api.progress?.error ?? "",
    "data-exported": String(api.progress?.exported ?? ""),
  });
}

describe("useExportTableData lifecycle", () => {
  beforeEach(() => {
    mocks.saveDialog.mockReset();
    mocks.runStreamingExport.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Cancel / requestCancel cancels the owned streaming export", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveDone!: (v: { exported: number }) => void;
    const done = new Promise<{ exported: number }>((r) => {
      resolveDone = r;
    });
    mocks.saveDialog.mockResolvedValue("/tmp/out.csv");
    mocks.runStreamingExport.mockReturnValue({ cancel, done });

    let api!: Api;
    render(h(Harness, { onReady: (a) => (api = a) }));
    await waitFor(() => expect(api).toBeTruthy());

    await act(async () => {
      void api.handleExport("users", 10, config);
    });
    await waitFor(() => expect(mocks.runStreamingExport).toHaveBeenCalled());
    await waitFor(() => expect(api.exporting).toBe(true));

    let cancelRequest!: Promise<void>;
    await act(async () => {
      cancelRequest = api.requestCancel();
      await Promise.resolve();
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(api.exporting).toBe(true);

    await act(async () => {
      resolveDone({ exported: 0 });
      await done;
      await cancelRequest;
    });
    await waitFor(() => expect(api.exporting).toBe(false));
  });

  it("unmount cancels the owned export", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const done = new Promise<{ exported: number }>(() => {});
    mocks.saveDialog.mockResolvedValue("/tmp/out.csv");
    mocks.runStreamingExport.mockReturnValue({ cancel, done });

    let api!: Api;
    const view = render(h(Harness, { onReady: (a) => (api = a) }));
    await waitFor(() => expect(api).toBeTruthy());

    await act(async () => {
      void api.handleExport("users", 10, config);
    });
    await waitFor(() => expect(mocks.runStreamingExport).toHaveBeenCalled());

    view.unmount();
    await waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it("context change (loadExportOptions) cancels and invalidates pending save dialog", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveSave!: (path: string | null) => void;
    mocks.saveDialog.mockImplementation(
      () =>
        new Promise<string | null>((r) => {
          resolveSave = r;
        })
    );
    mocks.runStreamingExport.mockReturnValue({
      cancel,
      done: Promise.resolve({ exported: 1 }),
    });

    let api!: Api;
    render(h(Harness, { onReady: (a) => (api = a), autoLoad: false }));
    await waitFor(() => expect(api).toBeTruthy());

    await act(async () => {
      await api.loadExportOptions(columns, "users");
    });

    await act(async () => {
      void api.handleExport("users", 10, config);
    });
    await waitFor(() => expect(mocks.saveDialog).toHaveBeenCalled());

    // Context change while save dialog is open.
    await act(async () => {
      await api.loadExportOptions(columns, "other_table");
    });

    await act(async () => {
      resolveSave("/tmp/orphan.csv");
    });

    // Allow microtasks from late save response.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.runStreamingExport).not.toHaveBeenCalled();
  });

  it("pending save-dialog completion after unmount does not start an orphan export", async () => {
    let resolveSave!: (path: string | null) => void;
    mocks.saveDialog.mockImplementation(
      () =>
        new Promise<string | null>((r) => {
          resolveSave = r;
        })
    );
    mocks.runStreamingExport.mockReturnValue({
      cancel: vi.fn(),
      done: Promise.resolve({ exported: 1 }),
    });

    let api!: Api;
    const view = render(
      h(Harness, { onReady: (a) => (api = a), autoLoad: false })
    );
    await waitFor(() => expect(api).toBeTruthy());
    await act(async () => {
      await api.loadExportOptions(columns, "users");
    });

    await act(async () => {
      void api.handleExport("users", 10, config);
    });
    await waitFor(() => expect(mocks.saveDialog).toHaveBeenCalled());

    view.unmount();

    await act(async () => {
      resolveSave("/tmp/orphan.csv");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.runStreamingExport).not.toHaveBeenCalled();
  });
});
