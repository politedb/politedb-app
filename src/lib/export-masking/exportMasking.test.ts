import { describe, expect, it } from "vitest";
import {
  REDACTED_TEXT,
  SYNTHETIC_KEEP_VALUE,
  applyMaskRule,
  buildDefaultMaskedPolicy,
  buildSyntheticPreview,
  freezePolicy,
  listKeepColumns,
  listOutputColumns,
  ordinaryPolicy,
  transformExportChunk,
  validateMaskingPolicy,
  withColumnRule,
} from "./index";

const SENSITIVE = "SECRET_EMAIL_alice@example.com";

function cellStr(v: string) {
  return { t: "Str" as const, v };
}

describe("export masking policy", () => {
  it("defaults selected columns to keep (passthrough)", () => {
    const p = buildDefaultMaskedPolicy(["a", "b"]);
    expect(p.masked).toBe(true);
    expect(p.rulesByColumn.a).toBe("keep");
    expect(p.rulesByColumn.b).toBe("keep");
  });

  it("rejects empty selection and zero output columns in masked mode", () => {
    expect(validateMaskingPolicy(buildDefaultMaskedPolicy([]), ["a"]).ok).toBe(
      false
    );
    let p = buildDefaultMaskedPolicy(["a", "b"]);
    p = withColumnRule(withColumnRule(p, "a", "omit"), "b", "omit");
    const v = validateMaskingPolicy(p, ["a", "b"]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe("ZERO_OUTPUT_COLUMNS");
  });

  it("blocks missing and stale rules (never Keep)", () => {
    const p = freezePolicy({
      masked: true,
      selectedColumns: ["a"],
      rulesByColumn: {},
    });
    const missing = validateMaskingPolicy(p, ["a"]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("MISSING_RULE");

    const stale = validateMaskingPolicy(buildDefaultMaskedPolicy(["gone"]), [
      "a",
    ]);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_COLUMN");
  });

  it("lists keep columns for Keep treatments", () => {
    let p = buildDefaultMaskedPolicy(["a", "b"]);
    expect(listKeepColumns(p)).toEqual(["a", "b"]);
    p = withColumnRule(p, "a", "redact");
    expect(listKeepColumns(p)).toEqual(["b"]);
  });
});

describe("applyMaskRule / transformExportChunk", () => {
  it("redacts non-null cells and preserves nulls", () => {
    expect(applyMaskRule(cellStr(SENSITIVE), "redact")).toEqual({
      t: "Str",
      v: REDACTED_TEXT,
    });
    expect(applyMaskRule({ t: "Null" }, "redact")).toEqual({ t: "Null" });
    expect(applyMaskRule(null, "redact")).toEqual({ t: "Null" });
  });

  it("set_null replaces any cell with Null CellValue", () => {
    expect(applyMaskRule(cellStr(SENSITIVE), "set_null")).toEqual({
      t: "Null",
    });
    expect(applyMaskRule({ t: "I64", v: 1 }, "set_null")).toEqual({
      t: "Null",
    });
  });

  it("handles unicode, multiline, quotes, typed, json, binary", () => {
    const policy = freezePolicy({
      masked: true,
      selectedColumns: ["u", "m", "q", "n", "b", "j", "bin", "empty"],
      rulesByColumn: {
        u: "redact",
        m: "redact",
        q: "keep",
        n: "set_null",
        b: "keep",
        j: "redact",
        bin: "redact",
        empty: "keep",
      },
    });
    const cols = policy.selectedColumns as string[];
    const row = [
      cellStr("日本語"),
      cellStr("line1\nline2"),
      cellStr('say "hi"'),
      { t: "I64", v: 7 },
      { t: "Bool", v: true },
      { t: "Json", v: `{"x":"${SENSITIVE}"}` },
      { t: "BytesB64", v: "AQID" },
      cellStr(""),
    ];
    const original = row.map((c) =>
      typeof c === "object" && c ? { ...c } : c
    );
    const result = transformExportChunk({
      policy,
      chunkColumns: cols,
      rows: [row],
      expectedProjectedColumns: cols,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.rows[0]!;
    expect(out[0]).toEqual({ t: "Str", v: REDACTED_TEXT });
    expect(out[2]).toEqual(cellStr('say "hi"'));
    expect(out[3]).toEqual({ t: "Null" });
    expect(JSON.stringify(result.rows)).not.toContain(SENSITIVE);
    expect(row[0]).toEqual(original[0]);
    expect((row[5] as { v: string }).v).toContain(SENSITIVE);
  });

  it("omission removes headers and values", () => {
    let policy = buildDefaultMaskedPolicy(["keep_me", "drop_me"]);
    policy = withColumnRule(policy, "keep_me", "keep");
    policy = withColumnRule(policy, "drop_me", "omit");
    expect(listOutputColumns(policy)).toEqual(["keep_me"]);
    const result = transformExportChunk({
      policy,
      chunkColumns: ["keep_me"],
      rows: [[cellStr(SENSITIVE)]],
      expectedProjectedColumns: ["keep_me"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.columns).toEqual(["keep_me"]);
    expect(result.rows[0]).toEqual([cellStr(SENSITIVE)]);
  });

  it("fails closed on schema mismatch / reordered columns", () => {
    const policy = buildDefaultMaskedPolicy(["a", "b"]);
    const bad = transformExportChunk({
      policy,
      chunkColumns: ["b", "a"],
      rows: [[1, 2]],
      expectedProjectedColumns: ["a", "b"],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("SCHEMA_MISMATCH");
  });

  it("ordinary policy copies rows without masking", () => {
    const policy = ordinaryPolicy(["a"]);
    const row = [cellStr(SENSITIVE)];
    const result = transformExportChunk({
      policy,
      chunkColumns: ["a"],
      rows: [row],
      expectedProjectedColumns: ["a"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual(row);
    expect(result.rows[0]).not.toBe(row);
  });
});

describe("synthetic preview", () => {
  it("default Keep preview shows synthetic sensitive marker", () => {
    const policy = buildDefaultMaskedPolicy(["email", "id"]);
    const preview = buildSyntheticPreview({ policy, column: "email" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.columns).toEqual(["email", "id"]);
    expect(preview.rows[0]?.[0]).toEqual({
      t: "Str",
      v: SYNTHETIC_KEEP_VALUE,
    });
  });

  it("redact preview uses [REDACTED] without keep sentinel", () => {
    let policy = buildDefaultMaskedPolicy(["email"]);
    policy = withColumnRule(policy, "email", "redact");
    const preview = buildSyntheticPreview({ policy, column: "email" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.rows[0]?.[0]).toEqual({ t: "Str", v: REDACTED_TEXT });
    expect(JSON.stringify(preview.rows)).not.toContain(SYNTHETIC_KEEP_VALUE);
  });
});
