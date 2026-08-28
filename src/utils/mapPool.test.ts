import { describe, expect, it } from "vitest";
import { mapPool } from "./mapPool";

describe("mapPool", () => {
  it("preserves order with a concurrency cap", async () => {
    const seen: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await mapPool(
      [10, 20, 30, 40, 50],
      2,
      async (item, index) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(index);
        await Promise.resolve();
        inFlight -= 1;
        return item * 2;
      }
    );

    expect(result).toEqual([20, 40, 60, 80, 100]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(seen).toHaveLength(5);
  });
});
