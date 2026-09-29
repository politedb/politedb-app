import { describe, expect, it } from "vitest";
import {
  formatHealthInspectorTimestamp,
  latestHealthTimestamp,
} from "./format";

describe("formatHealthInspectorTimestamp", () => {
  it("formats ISO instants as local YYYY-MM-DD HH:mm:ss", () => {
    const input = "2024-01-02T09:46:39.062662+00:00";
    const local = new Date(input);
    const pad = (part: number) => String(part).padStart(2, "0");
    const expected = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;

    expect(formatHealthInspectorTimestamp(input)).toBe(expected);
    expect(formatHealthInspectorTimestamp(input)).not.toContain("T");
    expect(formatHealthInspectorTimestamp(input)).not.toContain(".");
    expect(formatHealthInspectorTimestamp(input)).not.toMatch(
      /[zZ]|[+-]\d{2}:?\d{2}$/
    );
  });

  it("uses a placeholder for missing or invalid timestamps", () => {
    expect(formatHealthInspectorTimestamp(null)).toBe("—");
    expect(formatHealthInspectorTimestamp("not-a-timestamp")).toBe("—");
  });
});

describe("latestHealthTimestamp", () => {
  it("prefers the chronologically latest valid timestamp", () => {
    const older = "2024-01-01T00:00:00.000Z";
    const newer = "2024-06-01T12:00:00.000Z";
    expect(latestHealthTimestamp(older, newer)).toBe(newer);
    expect(latestHealthTimestamp(newer, older)).toBe(newer);
  });

  it("handles nulls and prefers the only valid value", () => {
    const only = "2024-03-01T00:00:00.000Z";
    expect(latestHealthTimestamp(null, only)).toBe(only);
    expect(latestHealthTimestamp(only, null)).toBe(only);
    expect(latestHealthTimestamp(null, null)).toBeNull();
    expect(latestHealthTimestamp("not-a-date", only)).toBe(only);
  });
});
