import { describe, expect, it } from "vitest";
import { cellToString, cellToUtf8String } from "./convert";

describe("cellToString", () => {
  it("renders binary cells as uppercase hex", () => {
    expect(cellToString({ t: "BytesB64", v: "AQID/w==" })).toBe("010203FF");
  });

  it("decodes byte cells as UTF-8 when explicitly requested", () => {
    expect(cellToUtf8String({ t: "BytesB64", v: "aW50" })).toBe("int");
    expect(cellToUtf8String({ t: "BytesB64", v: "dmFyY2hhcg==" })).toBe(
      "varchar"
    );
  });
});
