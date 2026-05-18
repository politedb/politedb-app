import { describe, expect, it } from "vitest";
import {
  analyzePatchIdentitySafety,
  generateSqlFromPatches,
  generateSqlPlanFromPatches,
  generateUpdateSqlFromPatches,
  type PatchMap,
} from "./generateSql";

function mysqlJsonDisplayLiteral(value: unknown) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const hex = Array.from(new TextEncoder().encode(json))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `CONVERT(UNHEX('${hex}') USING utf8mb4)`;
}

describe("generateUpdateSqlFromPatches", () => {
  it("serializes MySQL JSON updates and avoids JSON columns in fallback WHERE", () => {
    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": {
              json_value: {
                mdm: {
                  ios_updates: {
                    deadline: null,
                    minimum_version: null,
                  },
                },
              },
            },
          },
        },
      },
      "fleet",
      "app_config_json",
      {
        columns: [
          { name: "id", db_type: "int" },
          { name: "json_value", db_type: "json" },
        ],
        rows: [[1, { t: "Json", v: '{"old":true}' }]],
        rowCount: 1,
      },
      [],
      "mysql"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("UPDATE `fleet`.`app_config_json`");
    expect(sql[0]).toContain(
      `\`json_value\` = ${mysqlJsonDisplayLiteral({
        mdm: {
          ios_updates: {
            deadline: null,
            minimum_version: null,
          },
        },
      })}`
    );
    expect(sql[0]).toContain("WHERE `id` = 1;");
    expect(sql[0]).not.toContain("WHERE `json_value`");
    expect(sql[0]).not.toContain("AND `json_value`");
  });

  it("uses the primary key for MySQL JSON updates when available", () => {
    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": {
              json_value: '{"enabled":true}',
            },
          },
        },
      },
      "fleet",
      "app_config_json",
      {
        columns: [
          { name: "id", db_type: "int" },
          { name: "json_value", db_type: "json" },
        ],
        rows: [[1, { t: "Json", v: '{"old":true}' }]],
        rowCount: 1,
      },
      [
        {
          index_name: "PRIMARY",
          index_algorithm: "BTREE",
          is_unique: true,
          is_primary: true,
          column_name: "id",
        },
      ],
      "mysql"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain(
      `\`json_value\` = ${mysqlJsonDisplayLiteral('{"enabled":true}')}`
    );
    expect(sql[0]).toContain("WHERE `id` = 1;");
    expect(sql[0]).not.toContain("AND `json_value`");
  });

  it("normalizes double-encoded JSON strings for MySQL updates", () => {
    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": {
              json_value: '"{\\"mdm\\":{\\"enabled\\":true}}"',
            },
          },
        },
      },
      "fleet",
      "app_config_json",
      {
        columns: [
          { name: "id", db_type: "int" },
          { name: "json_value", db_type: "json" },
        ],
        rows: [[1, { t: "Json", v: '{"old":true}' }]],
        rowCount: 1,
      },
      [
        {
          index_name: "PRIMARY",
          index_algorithm: "BTREE",
          is_unique: true,
          is_primary: true,
          column_name: "id",
        },
      ],
      "mysql"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain(
      `\`json_value\` = ${mysqlJsonDisplayLiteral('{"mdm":{"enabled":true}}')}`
    );
    expect(sql[0]).not.toContain("CAST(0x");
    expect(sql[0]).toContain("WHERE `id` = 1;");
  });

  it("keeps MySQL JSON literals readable for backslashes and single quotes", () => {
    const jsonValue = {
      pattern: "password\\\\s*[:=]\\\\s*[\\\"\\'][^\\\"\\'\\\\n]{8,}",
    };
    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": {
              json_value: jsonValue,
            },
          },
        },
      },
      "fleet",
      "app_config_json",
      {
        columns: [
          { name: "id", db_type: "int" },
          { name: "json_value", db_type: "json" },
        ],
        rows: [[1, { t: "Json", v: '{"old":true}' }]],
        rowCount: 1,
      },
      [
        {
          index_name: "PRIMARY",
          index_algorithm: "BTREE",
          is_unique: true,
          is_primary: true,
          column_name: "id",
        },
      ],
      "mysql"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain(
      `\`json_value\` = ${mysqlJsonDisplayLiteral(jsonValue)}`
    );
    expect(sql[0]).toContain("CONVERT(UNHEX(");
    expect(sql[0]).not.toContain("password\\\\");
    expect(sql[0]).not.toContain("CAST(0x");
    expect(sql[0]).toContain("WHERE `id` = 1;");
  });

  it("keeps JSON payloads with closing arrays and quotes syntax safe for MySQL", () => {
    const jsonValue = {
      mdm: {
        secrets: ['token"]}},"overrides":{}'],
      },
      fleet_desktop: {
        transparency_url: "",
      },
      smtp_settings: {
        password: "p'ass\\word",
      },
    };

    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": {
              json_value: jsonValue,
            },
          },
        },
      },
      "fleet",
      "app_config_json",
      {
        columns: [
          { name: "id", db_type: "int" },
          { name: "json_value", db_type: "json" },
        ],
        rows: [[1, { t: "Json", v: '{"old":true}' }]],
        rowCount: 1,
      },
      [
        {
          index_name: "PRIMARY",
          index_algorithm: "BTREE",
          is_unique: true,
          is_primary: true,
          column_name: "id",
        },
      ],
      "mysql"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain(
      `\`json_value\` = ${mysqlJsonDisplayLiteral(jsonValue)}`
    );
    expect(sql[0]).toContain("CONVERT(UNHEX(");
    expect(sql[0]).not.toContain('"]}}');
    expect(sql[0]).toContain("WHERE `id` = 1;");
  });

  it("serializes MySQL JSON payloads with apostrophes through a hex utf8 literal", () => {
    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": {
              json_value: {
                regex: "password\\s*[:=]\\s*[\"'][^\"'\\n]{8,}[\"']",
              },
            },
          },
        },
      },
      "fleet",
      "app_config_json",
      {
        columns: [
          { name: "id", db_type: "int" },
          { name: "json_value", db_type: "json" },
        ],
        rows: [[1, { t: "Json", v: '{"old":true}' }]],
        rowCount: 1,
      },
      [],
      "mysql"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("CONVERT(UNHEX(");
    expect(sql[0]).not.toContain("[\\\"\\']");
    expect(sql[0]).not.toContain("\\u0027");
  });

  it("uses a virtual identity from safe columns when no primary key exists", () => {
    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": {
              name: "new",
            },
          },
        },
      },
      "public",
      "events",
      {
        columns: [
          { name: "name", db_type: "text" },
          { name: "payload", db_type: "json" },
          { name: "raw", db_type: "bytea" },
        ],
        rows: [["old", { t: "Json", v: '{"a":1}' }, "abc"]],
        rowCount: 1,
      },
      [],
      "mysql"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("WHERE `name` = CONVERT(UNHEX(");
    expect(sql[0]).not.toContain("`payload`");
    expect(sql[0]).not.toContain("`raw`");
  });

  it("blocks unsafe fallback updates when no primary key or safe virtual key exists", () => {
    expect(() =>
      generateUpdateSqlFromPatches(
        {
          update: {
            data: {
              "0": {
                payload: { next: true },
              },
            },
          },
        },
        "public",
        "events",
        {
          columns: [{ name: "payload", db_type: "json" }],
          rows: [[{ t: "Json", v: '{"a":1}' }]],
          rowCount: 1,
        },
        [],
        "mysql"
      )
    ).toThrow("TABLE_EDIT_UNSAFE_IDENTITY");
  });

  it("reports virtual key safety metadata for tables without primary keys", () => {
    const issues = analyzePatchIdentitySafety(
      {
        "table:public.events": {
          tableWindow: {
            id: "table:public.events",
            type: "table",
            table: { schema: "public", name: "events" },
          },
          tableData: {
            columns: [
              { name: "name", db_type: "text" },
              { name: "payload", db_type: "json" },
            ],
            structure: null,
            constraints: [],
            foreignKeys: null,
            sizeInfo: null,
            rowCount: 1,
            connectionId: null,
            busy: false,
            error: null,
          },
          patches: {
            update: {
              data: {
                "0": {
                  name: "new",
                },
              },
            },
          },
        },
      },
      "mysql"
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "virtual-key",
      columns: ["name"],
      tableKey: "public.events",
    });
  });
});

describe("generateSqlPlanFromPatches", () => {
  it("uses the offset row when generating update predicates from a paged table", () => {
    const patchMap: PatchMap = {
      "table:public.users": {
        tableWindow: {
          id: "table:public.users",
          type: "table",
          table: { schema: "public", name: "users" },
        },
        tableData: {
          columns: [
            { name: "id", db_type: "int" },
            { name: "name", db_type: "text" },
          ],
          structure: null,
          constraints: [
            {
              index_name: "users_pkey",
              index_algorithm: "BTREE",
              is_unique: true,
              is_primary: true,
              column_name: "id",
            },
          ],
          foreignKeys: null,
          sizeInfo: null,
          rowCount: 100,
          connectionId: "conn",
          busy: false,
          error: null,
        },
        patches: {
          update: {
            data: {
              "0": { name: "Ada" },
            },
          },
        },
      },
    };

    const sql = generateSqlFromPatches(patchMap, "postgres", {
      activeScreen: "screen",
      offset: 50,
      getRowAt: (_key, rowIndex) =>
        rowIndex === 50 ? [51, "Old Ada"] : [1, "Wrong row"],
    });

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain(`WHERE "id" = 51;`);
    expect(sql[0]).not.toContain(`WHERE "id" = 1;`);
  });

  it("orders structure changes before data and constraints", () => {
    const patchMap: PatchMap = {
      "table:public.users": {
        tableWindow: {
          id: "table:public.users",
          type: "table",
          table: { schema: "public", name: "users" },
        },
        tableData: {
          columns: [
            { name: "id", db_type: "int" },
            { name: "name", db_type: "text" },
          ],
          structure: [
            {
              column_name: "id",
              data_type: "int",
              is_nullable: "NO",
              check: "",
              column_default: "",
              foreign_key: "",
              comment: "",
            },
          ],
          constraints: [],
          foreignKeys: [],
          sizeInfo: null,
          rowCount: 0,
          connectionId: "conn",
          busy: false,
          error: null,
        },
        patches: {
          create: {
            structure: {
              "1": {
                column_name: "name",
                data_type: "text",
                is_nullable: true,
              },
            },
            data: {
              new: { id: 1, name: "Ada" },
            },
            constraints: {
              "0": {
                index_name: "users_name_idx",
                column_name: "name",
                is_unique: false,
                index_algorithm: "BTREE",
              },
            },
          },
        },
      },
    };

    const plan = generateSqlPlanFromPatches(patchMap, "postgres");
    expect(plan.preData[0]).toContain("ADD COLUMN");
    expect(plan.data[0]).toContain("INSERT INTO");
    expect(plan.postData[0]).toContain("CREATE INDEX");
    expect(generateSqlFromPatches(patchMap, "postgres")).toEqual([
      ...plan.preData,
      ...plan.data,
      ...plan.postData,
    ]);
  });
});
