import { describe, expect, it } from "vitest";
import {
  cellToBinaryHexString,
  cellToString,
  formatBytesB64AsHex,
} from "./convert";

describe("cell conversion", () => {
  it("keeps BytesB64 text conversion backward compatible", () => {
    expect(cellToString({ t: "BytesB64", v: "aW50" })).toBe("int");
  });

  it("formats binary cells as hex only through the binary converter", () => {
    expect(formatBytesB64AsHex("AQID/w==")).toBe("010203FF");
    expect(cellToBinaryHexString({ t: "BytesB64", v: "AQID/w==" })).toBe(
      "010203FF"
    );
  });

  it("preserves null semantics for both converters", () => {
    expect(cellToString({ t: "Null" }, true)).toBeNull();
    expect(cellToBinaryHexString({ t: "Null" }, true)).toBeNull();
  });
});
