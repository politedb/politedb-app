import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStreamingExport } from "./runStreamingExport";
import type { ExportConfig, ExportOptions } from "./types";

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  append: vi.fn(),
  publish: vi.fn(),
  abort: vi.fn(),
  startStream: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("src/lib/tauri/export", () => ({
  exportSessionBegin: (...args: unknown[]) => mocks.begin(...args),
  exportSessionAppend: (...args: unknown[]) => mocks.append(...args),
  exportSessionPublish: (...args: unknown[]) => mocks.publish(...args),
  exportSessionAbort: (...args: unknown[]) => mocks.abort(...args),
}));

vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: (...args: unknown[]) => mocks.startStream(...args),
}));

vi.mock("src/lib/tauri", () => ({
  operationCancel: (...args: unknown[]) => mocks.cancel(...args),
}));

vi.mock("src/lib/tauri/operationBus", () => ({
  operationBus: {
    ensureInit: async () => {},
    subscribe: (...args: unknown[]) => mocks.subscribe(...args),
  },
}));

type Handlers = {
  onChunk?: (chunk: {
    rows: unknown[][];
    columns?: { name: string }[];
  }) => void | Promise<void>;
  onDone?: (done: { truncated?: boolean }) => void | Promise<void>;
  onError?: (err: unknown) => void | Promise<void>;
  awaitChunkHandlers?: boolean;
};

const config: ExportConfig = {
  connectionId: "c1",
  schema: "public",
  tableName: "users",
  columns: [
    { name: "id", db_type: "int" },
    { name: "email", db_type: "text" },
  ],
  appliedFilters: [],
  appliedFilterCombine: "AND",
};

const opts: ExportOptions = {
  format: "csv",
  fileName: "users",
  columns: ["id", "email"],
  csvOptions: {},
  nullToEmpty: true,
  masked: false,
  maskingPolicy: null,
};

function chunk(rows: unknown[][]) {
  return {
    rows,
    columns: [{ name: "id" }, { name: "email" }],
  };
}

describe("runStreamingExport lifecycle", () => {
  let handlers: Handlers | null;
  let unsub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = null;
    unsub = vi.fn();
    mocks.begin.mockReset().mockResolvedValue({ sessionId: "sess-1" });
    mocks.append.mockReset().mockResolvedValue(undefined);
    mocks.publish.mockReset().mockResolvedValue(undefined);
    mocks.abort.mockReset().mockResolvedValue(undefined);
    mocks.startStream.mockReset().mockResolvedValue("op-1");
    mocks.cancel.mockReset().mockResolvedValue(undefined);
    mocks.subscribe.mockReset().mockImplementation(async (_opId, h) => {
      handlers = h as Handlers;
      return unsub;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("cancel stops the owned operation, aborts temp, and does not publish", async () => {
    const { cancel, done } = runStreamingExport("/tmp/out.csv", config, opts, {
      onProgress: () => {},
    });

    await vi.waitFor(() => expect(handlers).not.toBeNull());
    await handlers!.onChunk?.(
      chunk([
        [
          { t: "Int", v: 1 },
          { t: "Str", v: "a@x.com" },
        ],
      ])
    );
    expect(mocks.append).toHaveBeenCalled();

    await cancel();
    const result = await done;

    expect(result.error).toMatch(/cancelled/i);
    expect(mocks.cancel).toHaveBeenCalledWith("op-1");
    expect(mocks.abort).toHaveBeenCalledWith("sess-1");
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(unsub).toHaveBeenCalled();
  });

  it("publish-in-flight cancel waits for commit and does not abort publication", async () => {
    let releasePublish!: () => void;
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    mocks.publish.mockImplementation(async () => {
      await publishGate;
    });

    const progressEvents: string[] = [];
    const { cancel, done } = runStreamingExport("/tmp/out.csv", config, opts, {
      onProgress: (p) => {
        progressEvents.push(p.error ? `err:${p.error}` : `ok:${p.exported}`);
      },
    });

    await vi.waitFor(() => expect(handlers).not.toBeNull());
    await handlers!.onChunk?.(
      chunk([
        [
          { t: "Int", v: 1 },
          { t: "Str", v: "a@x.com" },
        ],
      ])
    );

    const onDonePromise = handlers!.onDone?.({});
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));

    const cancelPromise = cancel();
    // Still publishing — cancel must not abort or report cancelled yet.
    expect(mocks.abort).not.toHaveBeenCalled();
    releasePublish();
    await onDonePromise;
    await cancelPromise;
    const result = await done;

    expect(result.error).toBeUndefined();
    expect(result.exported).toBe(1);
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith("sess-1");
    expect(progressEvents.some((e) => /cancelled/i.test(e))).toBe(false);
  });

  it("first append rejection terminates export without waiting for onDone", async () => {
    mocks.append.mockRejectedValueOnce(new Error("disk full"));

    const { done } = runStreamingExport("/tmp/out.csv", config, opts, {
      onProgress: () => {},
    });

    await vi.waitFor(() => expect(handlers).not.toBeNull());
    await handlers!.onChunk?.(
      chunk([
        [
          { t: "Int", v: 1 },
          { t: "Str", v: "secret" },
        ],
      ])
    );

    const result = await done;
    expect(result.error).toMatch(/disk full/i);
    expect(mocks.cancel).toHaveBeenCalledWith("op-1");
    expect(mocks.abort).toHaveBeenCalledWith("sess-1");
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(unsub).toHaveBeenCalled();

    // Backend never emits onDone; a late done must not publish.
    await handlers!.onDone?.({});
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
