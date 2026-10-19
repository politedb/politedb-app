import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDefaultMaskedPolicy,
  withColumnRule,
} from "src/lib/export-masking";
import { prepareFrozenExportRun } from "./runStreamingExport";
import type { ExportConfig, ExportOptions } from "./types";
import { useLicenseStore } from "src/stores/license";
import type { LicenseState } from "src/lib/tauri/license";

function setProAccess(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

const config: ExportConfig = {
  connectionId: "c1",
  schema: "public",
  tableName: "users",
  columns: [
    { name: "id", db_type: "int" },
    { name: "email", db_type: "text" },
    { name: "note", db_type: "text" },
  ],
  appliedFilters: [],
  appliedFilterCombine: "AND",
};

describe("prepareFrozenExportRun", () => {
  beforeEach(() => setProAccess(true));

  it("requires Pro for an active masking treatment", () => {
    setProAccess(false);
    const policy = withColumnRule(
      buildDefaultMaskedPolicy(["id", "email", "note"]),
      "email",
      "redact"
    );
    const opts: ExportOptions = {
      format: "csv",
      fileName: "users_masked",
      columns: ["id", "email", "note"],
      csvOptions: {},
      nullToEmpty: true,
      masked: true,
      maskingPolicy: policy,
    };
    expect(() => prepareFrozenExportRun("/tmp/out.csv", config, opts)).toThrow(
      /PRO_REQUIRED/
    );
  });

  it("keeps all-Keep exports free without Pro", () => {
    setProAccess(false);
    const opts: ExportOptions = {
      format: "csv",
      fileName: "users",
      columns: ["id", "email", "note"],
      csvOptions: {},
      nullToEmpty: true,
      masked: true,
      maskingPolicy: buildDefaultMaskedPolicy(["id", "email", "note"]),
    };
    expect(() =>
      prepareFrozenExportRun("/tmp/out.csv", config, opts)
    ).not.toThrow();
  });

  it("freezes masked config and excludes omit from projection", () => {
    let policy = buildDefaultMaskedPolicy(["id", "email", "note"]);
    policy = withColumnRule(policy, "email", "omit");
    policy = withColumnRule(policy, "id", "keep");
    const opts: ExportOptions = {
      format: "csv",
      fileName: "users_masked",
      columns: ["id", "email", "note"],
      csvOptions: {},
      nullToEmpty: true,
      masked: true,
      maskingPolicy: policy,
    };
    const frozen = prepareFrozenExportRun("/tmp/out.csv", config, opts);
    expect(frozen.projectedColumns).toEqual(["id", "note"]);
    expect(frozen.outputColumns).toEqual(["id", "note"]);
    expect(frozen.policy.rulesByColumn.email).toBe("omit");
    expect(frozen.policy.rulesByColumn).not.toBe(policy.rulesByColumn);
    expect(frozen.policy.selectedColumns).not.toBe(policy.selectedColumns);
  });

  it("rejects SQL format when a non-keep treatment is active", () => {
    const policy = withColumnRule(
      buildDefaultMaskedPolicy(["id"]),
      "id",
      "redact"
    );
    expect(() =>
      prepareFrozenExportRun("/tmp/out.sql", config, {
        format: "sql",
        fileName: "x",
        columns: ["id"],
        csvOptions: {},
        nullToEmpty: true,
        masked: true,
        maskingPolicy: policy,
      })
    ).toThrow(/SQL format is disabled/i);
  });

  it("allows SQL format when all treatments are Keep", () => {
    const policy = buildDefaultMaskedPolicy(["id", "email"]);
    const frozen = prepareFrozenExportRun("/tmp/out.sql", config, {
      format: "sql",
      fileName: "x",
      columns: ["id", "email"],
      csvOptions: {},
      nullToEmpty: true,
      masked: true,
      maskingPolicy: policy,
    });
    expect(frozen.projectedColumns).toEqual(["id", "email"]);
    expect(frozen.options.format).toBe("sql");
    // All-Keep collapses to ordinary semantics for SQL/null handling.
    expect(frozen.policy.masked).toBe(false);
  });

  it("ordinary export projects selected columns", () => {
    const frozen = prepareFrozenExportRun("/tmp/out.csv", config, {
      format: "csv",
      fileName: "users",
      columns: ["id", "email"],
      csvOptions: {},
      nullToEmpty: true,
      masked: false,
      maskingPolicy: null,
    });
    expect(frozen.projectedColumns).toEqual(["id", "email"]);
    expect(frozen.policy.masked).toBe(false);
  });
});
