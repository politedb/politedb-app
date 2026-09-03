import { describe, expect, it } from "vitest";
import {
  cellToBinaryHexString,
  cellToString,
  formatBytesB64AsHex,
  normalizeByteSizeLabel,
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

describe("normalizeByteSizeLabel", () => {
  it("converts raw byte labels to larger binary units", () => {
    expect(normalizeByteSizeLabel("8192 bytes")).toBe("8 KB");
    expect(normalizeByteSizeLabel("1024 B")).toBe("1 KB");
    expect(normalizeByteSizeLabel("65536")).toBe("64 KB");
    expect(normalizeByteSizeLabel(0)).toBe("0 Bytes");
  });

  it("preserves values already formatted by database", () => {
    expect(normalizeByteSizeLabel("2840 kB")).toBe("2840 kB");
    expect(normalizeByteSizeLabel("13 GB")).toBe("13 GB");
  });
});
