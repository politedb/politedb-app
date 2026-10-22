import { describe, expect, it } from "vitest";
import {
  formatCollectionDuration,
  formatExactCount,
  formatHealthInspectorTimestamp,
  formatInspectorBytes,
  formatRelativeAge,
  formatSnapshotTime,
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

describe("formatExactCount", () => {
  it("keeps safe integers exact and approximates unsafe values", () => {
    expect(formatExactCount(null)).toBe("—");
    expect(formatExactCount(42)).toBe("42");
    expect(formatExactCount(Number.MAX_SAFE_INTEGER + 2)).toMatch(/^≈/);
  });
});

describe("inspector display formats", () => {
  it("shows zero bytes as 0 B and unknown as a dash", () => {
    expect(formatInspectorBytes(0)).toBe("0 B");
    expect(formatInspectorBytes(null)).toBe("—");
    expect(formatInspectorBytes(2048)).toBe("2.0 KB");
  });

  it("formats snapshot age relative to now with the local clock", () => {
    const now = new Date(2026, 9, 21, 22, 37, 10).getTime();
    expect(formatRelativeAge(now - 10_000, now)).toBe("just now");
    expect(formatRelativeAge(now - 2 * 60_000, now)).toBe("2 min ago");
    expect(formatRelativeAge(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatRelativeAge(now - 2 * 86_400_000, now)).toBe("2 d ago");
    const taken = new Date(2026, 9, 21, 22, 35, 0).getTime();
    expect(formatSnapshotTime(taken, now)).toBe("2 min ago (22:35)");
  });

  it("formats collection duration", () => {
    expect(formatCollectionDuration(1_234)).toBe("1.2 s");
    expect(formatCollectionDuration(80)).toBe("0.1 s");
    expect(formatCollectionDuration(65_000)).toBe("1m 5s");
    expect(formatCollectionDuration(-1)).toBe("—");
  });
});
