import { describe, expect, it } from "vitest";
import { streamErrorText } from "./useSqlStreamResult";

describe("streamErrorText", () => {
  it("reads the error of an op:error payload", () => {
    expect(
      streamErrorText({ op_id: "op", error: "timeout", elapsed_ms: 3 })
    ).toBe("timeout");
  });

  it("accepts strings and Error-like values", () => {
    expect(streamErrorText("boom")).toBe("boom");
    expect(streamErrorText(new Error("bad"))).toBe("bad");
  });

  it("never stringifies an object", () => {
    expect(streamErrorText({ op_id: "op" })).toBe("Unknown error");
    expect(streamErrorText(null)).toBe("Unknown error");
  });
});
