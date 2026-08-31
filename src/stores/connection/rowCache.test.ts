import { describe, expect, it } from "vitest";
import type { TableRowCache } from "./types";
import { cacheGet, cachePut } from "./rowCache";

describe("row cache", () => {
  it("evicts old rows without shifting the order queue", () => {
    const cache: TableRowCache = {
      map: new Map(),
      order: [],
      orderHead: 0,
    };

    for (let index = 0; index < 100_513; index++) {
      cachePut(cache, index, [index]);
    }

    expect(cache.orderHead).toBe(512);
    expect(cache.map.size).toBe(100_001);
    expect(cacheGet(cache, 0)).toBeUndefined();
    expect(cacheGet(cache, 512)).toEqual([512]);
    expect(cacheGet(cache, 100_512)).toEqual([100_512]);
  });
});
