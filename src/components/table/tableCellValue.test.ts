import { describe, expect, it } from "vitest";
import { formatTableCellValue } from "./tableCellValue";

describe("formatTableCellValue", () => {
  it("renders MySQL binary columns as hex", () => {
    expect(
      formatTableCellValue({ t: "BytesB64", v: "AQID/w==" }, "longblob")
    ).toBe("010203FF");
  });

  it("keeps text metadata readable even when transported as bytes", () => {
    expect(formatTableCellValue({ t: "BytesB64", v: "aW50" }, "text")).toBe(
      "int"
    );
  });
});
