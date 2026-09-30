import { describe, expect, it } from "vitest";
import { createSerialWriter } from "./serialWriter";

describe("createSerialWriter", () => {
  it("serializes writes and counts completed writes", async () => {
    const order: string[] = [];
    const writer = createSerialWriter({
      maxPending: 4,
      write: async (content) => {
        order.push(`start:${content}`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`end:${content}`);
      },
    });

    const p1 = writer.enqueue("a");
    const p2 = writer.enqueue("b");
    await Promise.all([p1, p2]);
    await writer.drain();

    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(writer.completedWrites).toBe(2);
  });

  it("rejects when pending bound exceeded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writer = createSerialWriter({
      maxPending: 1,
      write: async () => {
        await gate;
      },
    });
    const first = writer.enqueue("a");
    await expect(writer.enqueue("b")).rejects.toThrow(/buffer full/);
    release();
    await first;
  });
});
