import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runSqlQuery } from "./query";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  track: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("src/lib/analytics", () => ({
  detectSqlKind: () => "select",
  trackEvent: mocks.track,
}));
vi.mock("src/lib/tauri", () => ({
  operationExecute: async () => "review_op",
  operationCancel: mocks.cancel,
}));
vi.mock("./operationBus", () => ({
  operationBus: {
    ensureInit: async () => {},
    subscribe: mocks.subscribe,
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.cancel.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("emits one timeout event for an ordinary query", async () => {
  mocks.subscribe.mockResolvedValue(vi.fn());
  const result = runSqlQuery("review_conn", "select 1", { timeoutMs: 10 });
  const rejected = expect(result).rejects.toThrow("SQL_QUERY_TIMEOUT");
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  expect(
    mocks.track.mock.calls.filter(([event]) => event === "sql_query_timeout")
  ).toHaveLength(1);
});

it("disposes a subscription returned after cancellation", async () => {
  let deliver!: (unsubscribe: () => void) => void;
  mocks.subscribe.mockImplementation(
    () =>
      new Promise<() => void>((resolve) => {
        deliver = resolve;
      })
  );
  const controller = new AbortController();
  const result = runSqlQuery("review_conn", "select 1", {
    signal: controller.signal,
    internal: true,
  });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.subscribe).toHaveBeenCalledOnce();
  controller.abort();
  await rejected;
  const unsubscribe = vi.fn();
  deliver(unsubscribe);
  await vi.advanceTimersByTimeAsync(0);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("disposes a subscription returned after timeout", async () => {
  let deliver!: (unsubscribe: () => void) => void;
  mocks.subscribe.mockImplementation(
    () =>
      new Promise<() => void>((resolve) => {
        deliver = resolve;
      })
  );
  const result = runSqlQuery("review_conn", "select 1", {
    timeoutMs: 10,
    internal: true,
  });
  const rejected = expect(result).rejects.toThrow("SQL_QUERY_TIMEOUT");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.subscribe).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10);
  await rejected;
  const unsubscribe = vi.fn();
  deliver(unsubscribe);
  await vi.advanceTimersByTimeAsync(0);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("disposes a subscription returned after terminal error replay", async () => {
  let deliver!: (unsubscribe: () => void) => void;
  let handlers!: { onError: (err: unknown) => void };
  mocks.subscribe.mockImplementation(
    (_opId: string, h: { onError: (err: unknown) => void }) => {
      handlers = h;
      return new Promise<() => void>((resolve) => {
        deliver = resolve;
      });
    }
  );
  const result = runSqlQuery("review_conn", "select 1", {
    timeoutMs: 0,
    internal: true,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.subscribe).toHaveBeenCalledOnce();
  // Terminal error arrives while subscribe IPC is still pending.
  handlers.onError(new Error("boom"));
  await expect(result).rejects.toThrow("boom");
  const unsubscribe = vi.fn();
  deliver(unsubscribe);
  await vi.advanceTimersByTimeAsync(0);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
