import { describe, expect, it } from "vitest";
import type { ForeignKeyInfo } from "src/types";
import {
  buildForeignKeyColumnMap,
  findFkForColumn,
  splitFkColumnList,
} from "./foreignKey";

const sampleFks: ForeignKeyInfo[] = [
  {
    constraint_name: "host_software_host_id_fkey",
    table_schema: "fleet",
    table_name: "host_software",
    column_names: "host_id",
    ref_table_schema: "fleet",
    ref_table_name: "hosts",
    ref_column_names: "id",
    on_update: "NO ACTION",
    on_delete: "CASCADE",
  },
  {
    constraint_name: "host_software_software_id_fkey",
    table_schema: "fleet",
    table_name: "host_software",
    column_names: "software_id",
    ref_table_schema: "fleet",
    ref_table_name: "software",
    ref_column_names: "id",
    on_update: "NO ACTION",
    on_delete: "CASCADE",
  },
];

describe("splitFkColumnList", () => {
  it("splits and trims aggregated column lists", () => {
    expect(splitFkColumnList("host_id, software_id")).toEqual([
      "host_id",
      "software_id",
    ]);
  });
});

describe("buildForeignKeyColumnMap", () => {
  it("maps single-column FKs by local column name", () => {
    expect(buildForeignKeyColumnMap(sampleFks)).toEqual({
      host_id: { schema: "fleet", table: "hosts", column: "id" },
      software_id: { schema: "fleet", table: "software", column: "id" },
    });
  });

  it("expands composite FK column lists to per-column links", () => {
    const composite: ForeignKeyInfo[] = [
      {
        constraint_name: "fk_pair",
        table_schema: "public",
        table_name: "child",
        column_names: "org_id,user_id",
        ref_table_schema: "public",
        ref_table_name: "org_users",
        ref_column_names: "org_id,id",
        on_update: "NO ACTION",
        on_delete: "NO ACTION",
      },
    ];
    expect(buildForeignKeyColumnMap(composite)).toEqual({
      org_id: { schema: "public", table: "org_users", column: "org_id" },
      user_id: { schema: "public", table: "org_users", column: "id" },
    });
  });

  it("skips incomplete FK rows", () => {
    expect(
      buildForeignKeyColumnMap([
        {
          ...sampleFks[0],
          column_names: "",
        },
      ])
    ).toEqual({});
  });
});

describe("findFkForColumn", () => {
  it("matches columns inside composite lists", () => {
    const fk = findFkForColumn(
      [
        {
          ...sampleFks[0],
          column_names: "host_id,software_id",
          ref_column_names: "id,id",
        },
      ],
      "software_id"
    );
    expect(fk?.constraint_name).toBe("host_software_host_id_fkey");
  });
});
