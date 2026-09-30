import { describe, expect, it } from "vitest";

/**
 * Focused behavioral test for awaitChunkHandlers semantics using a local
 * reimplementation of the serial queue contract (mirrors operationBus).
 * Full event-bus integration requires Tauri listen mocks.
 */

function createSerialQueue() {
  type OpQueue = { chain: Promise<void>; pending: number };
  const serialQueueByOp = new Map<string, OpQueue>();
  function getSerialQueue(opId: string): OpQueue {
    let q = serialQueueByOp.get(opId);
    if (!q) {
      q = { chain: Promise.resolve(), pending: 0 };
      serialQueueByOp.set(opId, q);
    }
    return q;
  }
  function enqueueSerial(opId: string, work: () => void | Promise<void>) {
    const q = getSerialQueue(opId);
    q.pending += 1;
    const run = q.chain.then(async () => {
      try {
        await work();
      } finally {
        q.pending -= 1;
      }
    });
    q.chain = run.catch(() => {});
    return run;
  }
  async function drain(opId: string) {
    await serialQueueByOp.get(opId)?.chain;
  }
  return { enqueueSerial, drain, serialQueueByOp };
}

describe("export backpressure serial queue contract", () => {
  it("runs chunk handlers in order and drains before done", async () => {
    const { enqueueSerial, drain } = createSerialQueue();
    const order: string[] = [];
    const slow = (label: string, ms: number) =>
      enqueueSerial("op1", async () => {
        order.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end:${label}`);
      });

    void slow("a", 30);
    void slow("b", 5);
    void slow("c", 1);
    await drain("op1");
    order.push("done");

    expect(order).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
      "done",
    ]);
  });

  it("keeps chain alive after a handler failure", async () => {
    const { enqueueSerial, drain } = createSerialQueue();
    const seen: string[] = [];
    void enqueueSerial("op1", async () => {
      seen.push("a");
      throw new Error("fail");
    });
    void enqueueSerial("op1", async () => {
      seen.push("b");
    });
    await drain("op1");
    expect(seen).toEqual(["a", "b"]);
  });
});
