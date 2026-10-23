import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyForAnalyze, explainModeFor } from "./analyzeClassify";

type Fixture = {
  sql: string;
  allowed: boolean;
  statement?: string;
  reason?: string;
};

// Same fixtures as the Rust classifier (explain_analyze.rs).
const fixtures: Fixture[] = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../src-tauri/tests/fixtures/analyze_classify.json"
    ),
    "utf8"
  )
);

describe("classifyForAnalyze (shared fixtures)", () => {
  it("has a meaningful fixture set", () => {
    expect(fixtures.length).toBeGreaterThan(20);
  });

  it.each(fixtures.map((f) => [f.sql, f] as const))("%s", (_sql, f) => {
    const result = classifyForAnalyze(f.sql);
    expect(result.ok).toBe(f.allowed);
    if (result.ok && f.statement !== undefined) {
      expect(result.statement).toBe(f.statement);
    }
    if (!result.ok && f.reason !== undefined) {
      expect(result.reason).toBe(f.reason);
    }
  });
});

describe("explainModeFor", () => {
  it("measures read statements and estimates everything else", () => {
    expect(explainModeFor("select * from users")).toBe("analyze");
    expect(explainModeFor("with t as (select 1) select * from t")).toBe(
      "analyze"
    );
    expect(explainModeFor("update users set name = 'x'")).toBe("estimate");
    expect(explainModeFor("delete from users")).toBe("estimate");
    expect(explainModeFor("select * from t for update")).toBe("estimate");
    expect(explainModeFor("select $1")).toBe("estimate");
  });
});
