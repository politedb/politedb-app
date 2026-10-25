import { describe, expect, it } from "vitest";
import type { TableStructure } from "src/types";
import {
  analyzePatchIdentitySafety,
  generateSqlFromPatches,
  generateSqlPlanFromPatches,
  generateDeleteSqlFromPatches,
  generateInsertSqlFromPatches,
  generateUpdateSqlFromPatches,
  type PatchMap,
} from "./generateSql";

describe("generateInsertSqlFromPatches", () => {
  it("preserves DEFAULT, NULL, empty strings, and values", () => {
    const sql = generateInsertSqlFromPatches(
      {
        create: {
          data: {
            "new:0": {
              id: { __politedbCellEdit: "default" },
              nullable_value: null,
              empty_value: "",
              title: "hello",
              __rowKey: "new:0",
            },
          },
        },
      },
      "public",
      "items",
      "postgres",
      [
        { name: "id", db_type: "integer" },
        { name: "nullable_value", db_type: "text" },
        { name: "empty_value", db_type: "text" },
        { name: "title", db_type: "text" },
      ]
    );

    expect(sql).toEqual([
      'INSERT INTO "public"."items" ("id", "nullable_value", "empty_value", "title")\nVALUES (DEFAULT, NULL, \'\', \'hello\');',
    ]);
  });
});

function mysqlJsonDisplayLiteral(value: unknown) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const hex = Array.from(new TextEncoder().encode(json))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `CONVERT(UNHEX('${hex}') USING utf8mb4)`;
}

describe("generateUpdateSqlFromPatches", () => {
  it("preserves empty-string and binary primary keys in UPDATE identity", () => {
    const emptyKeySql = generateUpdateSqlFromPatches(
      { update: { data: { "0": { title: "updated" } } } },
      "fleet",
      "items",
      {
        columns: [
          { name: "code", db_type: "varchar" },
          { name: "title", db_type: "varchar" },
        ],
        rows: [
          [
            { t: "Str", v: "" },
            { t: "Str", v: "old" },
          ],
        ],
        rowCount: 1,
      },
      [
        {
          index_name: "PRIMARY",
          index_algorithm: "BTREE",
          is_unique: true,
          is_primary: true,
          column_name: "code",
        },
      ],
      "mysql"
    );
    const binaryKeySql = generateUpdateSqlFromPatches(
      { update: { data: { "0": { title: "updated" } } } },
      "fleet",
      "binary_items",
      {
        columns: [
          { name: "id", db_type: "binary" },
          { name: "title", db_type: "varchar" },
        ],
        rows: [[{ t: "BytesB64", v: "AQID/w==" }, "old"]],
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

    expect(emptyKeySql[0]).toContain(
      "WHERE `code` = CONVERT(UNHEX('') USING utf8mb4)"
    );
    expect(emptyKeySql[0]).not.toContain("`code` IS NULL");
    expect(binaryKeySql[0]).toContain("WHERE `id` = X'010203ff';");
    expect(binaryKeySql[0]).not.toContain("AQID/w==");
  });

  it("MySQL UPDATE/DELETE WHERE uses real int/datetime values from BytesB64 cells", () => {
    const datetime = "2026-10-01 04:47:06.554675";
    const datetimeB64 = globalThis.btoa(datetime);
    const columns = [
      { name: "id", db_type: "int" },
      { name: "name", db_type: "varchar" },
      { name: "created_at", db_type: "datetime" },
    ];
    const rows = [
      [
        { t: "BytesB64", v: "Mw==" }, // "3"
        { t: "Str", v: "alice" },
        { t: "BytesB64", v: datetimeB64 },
      ],
    ];
    const constraints = [
      {
        index_name: "PRIMARY",
        index_algorithm: "BTREE",
        is_unique: true,
        is_primary: true,
        column_name: "id",
      },
    ];

    const updateSql = generateUpdateSqlFromPatches(
      { update: { data: { "0": { name: "bob" } } } },
      "fleet",
      "users_deleted",
      { columns, rows, rowCount: 1 },
      constraints,
      "mysql"
    );
    expect(updateSql).toHaveLength(1);
    expect(updateSql[0]).toContain("WHERE `id` = 3;");
    expect(updateSql[0]).not.toContain("WHERE `id` = 51");
    expect(updateSql[0]).not.toContain("50,48,50,54");

    const deleteSql = generateDeleteSqlFromPatches(
      { delete: { data: { "0": true } } },
      "fleet",
      "users_deleted",
      { columns, rows, rowCount: 1 },
      [],
      "mysql"
    );
    expect(deleteSql).toHaveLength(1);
    expect(deleteSql[0]).toContain("`id` = 3");
    expect(deleteSql[0]).toContain("`name` =");
    expect(deleteSql[0]).toContain("`created_at` =");
    expect(deleteSql[0]).not.toContain("`id` = 51");
    expect(deleteSql[0]).not.toContain("50,48,50,54");
  });

  it("MySQL fleet.users_deleted uses PRIMARY key WHERE when constraints load", () => {
    const columns = [
      { name: "id", db_type: "int" },
      { name: "name", db_type: "varchar" },
      { name: "created_at", db_type: "datetime" },
    ];
    const rows = [[3, "alice", "2026-10-01 04:47:06"]];
    const constraints = [
      {
        index_name: "PRIMARY",
        index_algorithm: "BTREE",
        // MySQL TRUE often arrives as 1 / "1" before string normalization
        is_unique: true,
        is_primary: "1" as unknown as boolean,
        column_name: "id",
      },
    ];

    const updateSql = generateUpdateSqlFromPatches(
      { update: { data: { "0": { name: "bob" } } } },
      "fleet",
      "users_deleted",
      { columns, rows, rowCount: 1 },
      constraints as never,
      "mysql"
    );
    expect(updateSql).toHaveLength(1);
    expect(updateSql[0]).toContain("WHERE `id` = 3;");
    expect(updateSql[0]).toMatch(/WHERE `id` = 3;?\s*$/);
    expect(updateSql[0]).not.toMatch(/WHERE[\s\S]*`name`/);
    expect(updateSql[0]).not.toMatch(/WHERE[\s\S]*`created_at`/);
  });

  it("MySQL uses column is_primary flags when constraints are missing", () => {
    const columns = [
      { name: "id", db_type: "int", is_primary: true },
      { name: "name", db_type: "varchar" },
      { name: "note", db_type: "text" },
    ];
    const rows = [[7, "alice", "x"]];

    const updateSql = generateUpdateSqlFromPatches(
      { update: { data: { "0": { name: "bob" } } } },
      "fleet",
      "users_deleted",
      { columns, rows, rowCount: 1 },
      null,
      "mysql"
    );
    expect(updateSql).toHaveLength(1);
    expect(updateSql[0]).toContain("WHERE `id` = 7;");
    expect(updateSql[0]).toMatch(/WHERE `id` = 7;?\s*$/);
    expect(updateSql[0]).not.toMatch(/WHERE[\s\S]*`name`/);
    expect(updateSql[0]).not.toMatch(/WHERE[\s\S]*`note`/);
  });

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

  it("formats ClickHouse Decimal values for UPDATE", () => {
    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": { total: 6941 },
          },
        },
      },
      "demo_db",
      "orders",
      {
        columns: [
          { name: "id", db_type: "UInt64" },
          { name: "total", db_type: "Decimal64(18, 2)" },
        ],
        rows: [[1, 6941]],
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
      "clickhouse"
    );

    expect(sql[0]).toContain("`total` = 6941.00");
    expect(sql[0]).not.toContain("`total` = 694100");
  });

  it("uses ALTER TABLE UPDATE for ClickHouse", () => {
    const sql = generateUpdateSqlFromPatches(
      {
        update: {
          data: {
            "0": { unit_price: 4991 },
          },
        },
      },
      "demo_db",
      "order_items",
      {
        columns: [
          { name: "id", db_type: "UInt64" },
          { name: "unit_price", db_type: "UInt32" },
        ],
        rows: [[1, 100]],
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
      "clickhouse"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain(
      "ALTER TABLE `demo_db`.`order_items` UPDATE `unit_price` = 4991 WHERE `id` = 1;"
    );
    expect(sql[0]).not.toMatch(/^UPDATE /);
  });

  it("uses ALTER TABLE DELETE for ClickHouse", () => {
    const sql = generateDeleteSqlFromPatches(
      {
        delete: {
          data: {
            "0": {},
          },
        },
      },
      "demo_db",
      "order_items",
      {
        columns: [{ name: "id", db_type: "UInt64" }],
        rows: [[1]],
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
      "clickhouse"
    );

    expect(sql).toHaveLength(1);
    expect(sql[0]).toBe(
      "ALTER TABLE `demo_db`.`order_items` DELETE WHERE `id` = 1;"
    );
  });

  it("preserves empty-string and binary primary keys in DELETE identity", () => {
    const emptyKeySql = generateDeleteSqlFromPatches(
      { delete: { data: { "0": {} } } },
      "fleet",
      "items",
      {
        columns: [{ name: "code", db_type: "varchar" }],
        rows: [[{ t: "Str", v: "" }]],
        rowCount: 1,
      },
      [
        {
          index_name: "PRIMARY",
          index_algorithm: "BTREE",
          is_unique: true,
          is_primary: true,
          column_name: "code",
        },
      ],
      "mysql"
    );
    const binaryKeySql = generateDeleteSqlFromPatches(
      { delete: { data: { "0": {} } } },
      "fleet",
      "binary_items",
      {
        columns: [{ name: "id", db_type: "longblob" }],
        rows: [[{ t: "BytesB64", v: "AQID/w==" }]],
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

    expect(emptyKeySql[0]).toContain(
      "WHERE `code` = CONVERT(UNHEX('') USING utf8mb4)"
    );
    expect(binaryKeySql[0]).toContain("WHERE `id` = X'010203ff';");
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

  it("blocks JSON/BLOB-only virtual keys across relational engines", () => {
    for (const engine of ["postgres", "mysql", "sqlite"] as const) {
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
            columns: [
              {
                name: "payload",
                db_type: engine === "postgres" ? "jsonb" : "json",
              },
              {
                name: "raw",
                db_type: engine === "postgres" ? "bytea" : "blob",
              },
            ],
            rows: [[{ t: "Json", v: '{"a":1}' }, "abc"]],
            rowCount: 1,
          },
          [],
          engine
        )
      ).toThrow("TABLE_EDIT_UNSAFE_IDENTITY");
    }
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

describe("column and index flags written as text", () => {
  // The structure editor commits "true"/"false" strings; the catalog says
  // YES/NO. A non-empty string must not count as true.
  const usersTable = (patches: unknown): PatchMap =>
    ({
      "table:public.users": {
        tableWindow: {
          id: "table:public.users",
          type: "table",
          table: { schema: "public", name: "users" },
        },
        tableData: {
          columns: [
            { name: "id", db_type: "int" },
            { name: "email", db_type: "text" },
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
            {
              column_name: "email",
              data_type: "text",
              is_nullable: "YES",
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
        patches,
      },
    }) as unknown as PatchMap;

  it('sets NOT NULL for "false" and drops it for "true"', () => {
    expect(
      generateSqlFromPatches(
        usersTable({
          update: { structure: { "1": { is_nullable: "false" } } },
        }),
        "postgres"
      )
    ).toEqual([
      'ALTER TABLE "public"."users" ALTER COLUMN "email" SET NOT NULL;',
    ]);
    expect(
      generateSqlFromPatches(
        usersTable({ update: { structure: { "0": { is_nullable: "true" } } } }),
        "postgres"
      )
    ).toEqual([
      'ALTER TABLE "public"."users" ALTER COLUMN "id" DROP NOT NULL;',
    ]);
  });

  it("changes nothing when only the spelling differs", () => {
    expect(
      generateSqlFromPatches(
        usersTable({
          update: {
            structure: {
              "0": { is_nullable: "false" },
              "1": { is_nullable: "true" },
            },
          },
        }),
        "postgres"
      )
    ).toEqual([]);
  });

  it("adds a column NOT NULL only when asked", () => {
    const add = (is_nullable: unknown) =>
      generateSqlFromPatches(
        usersTable({
          create: {
            structure: {
              "2": { column_name: "n", data_type: "text", is_nullable },
            },
          },
        }),
        "postgres"
      );
    expect(add("false")[0]).toContain('"n" text NOT NULL');
    expect(add("NO")[0]).toContain('"n" text NOT NULL');
    expect(add("true")[0]).not.toContain("NOT NULL");
    expect(add("YES")[0]).not.toContain("NOT NULL");
    expect(add("")[0]).not.toContain("NOT NULL");
  });

  it('creates a plain index for unique "false"', () => {
    const create = (is_unique: unknown) =>
      generateSqlFromPatches(
        usersTable({
          create: {
            constraints: {
              "0": {
                index_name: "users_email_idx",
                column_name: "email",
                is_unique,
                index_algorithm: "BTREE",
              },
            },
          },
        }),
        "postgres"
      );
    expect(create("false")[0]).toMatch(/^CREATE INDEX /);
    expect(create("true")[0]).toMatch(/^CREATE UNIQUE INDEX /);
  });
});

describe("structure edits keep what the user did not change", () => {
  const table = (
    engine: string,
    structure: Record<string, unknown>[],
    constraints: Record<string, unknown>[],
    patches: unknown
  ): PatchMap =>
    ({
      [`table:${engine}`]: {
        tableWindow: {
          id: `table:${engine}`,
          type: "table",
          table: { schema: "shop", name: "items" },
        },
        tableData: {
          columns: [],
          structure,
          constraints,
          foreignKeys: [],
          sizeInfo: null,
          rowCount: 0,
          connectionId: "conn",
          busy: false,
          error: null,
        },
        patches,
      },
    }) as unknown as PatchMap;

  const mysqlColumn: TableStructure = {
    column_name: "qty",
    data_type: "int",
    is_nullable: false,
    check: "",
    column_default: "7",
    foreign_key: "",
    comment: "How many",
    extra: "",
    collation: "",
  };
  const mysqlEdit = (patch: Record<string, unknown>, column = mysqlColumn) =>
    generateSqlFromPatches(
      table("mysql", [column], [], { update: { structure: { "0": patch } } }),
      "mysql"
    );

  it("MySQL: a type change restates NOT NULL, default and comment", () => {
    expect(mysqlEdit({ data_type: "bigint" })).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `qty` bigint NOT NULL DEFAULT 7 COMMENT 'How many';",
    ]);
  });

  it("MySQL: a nullable-only change keeps the type and default", () => {
    expect(mysqlEdit({ is_nullable: "YES" })).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `qty` int NULL DEFAULT 7 COMMENT 'How many';",
    ]);
  });

  it("MySQL: keeps AUTO_INCREMENT, ON UPDATE and collation", () => {
    expect(
      mysqlEdit(
        { data_type: "bigint unsigned" },
        {
          ...mysqlColumn,
          column_default: null as unknown as string,
          comment: "",
          extra: "auto_increment",
        }
      )
    ).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `qty` bigint unsigned NOT NULL AUTO_INCREMENT;",
    ]);
    expect(
      mysqlEdit(
        { is_nullable: "NO" },
        {
          ...mysqlColumn,
          column_name: "updated_at",
          data_type: "timestamp",
          is_nullable: true,
          column_default: "CURRENT_TIMESTAMP",
          comment: "",
          extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
        }
      )
    ).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;",
    ]);
    expect(
      mysqlEdit(
        { data_type: "varchar(80)" },
        {
          ...mysqlColumn,
          column_name: "name",
          data_type: "varchar(40)",
          column_default: "it's",
          comment: "",
          collation: "utf8mb4_bin",
        }
      )
    ).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `name` varchar(80) COLLATE utf8mb4_bin NOT NULL DEFAULT 'it''s';",
    ]);
  });

  it("MySQL: refuses to restate a generated column", () => {
    expect(() =>
      mysqlEdit(
        { data_type: "bigint" },
        { ...mysqlColumn, extra: "STORED GENERATED" }
      )
    ).toThrow(/generated column/);
  });

  const index = {
    index_name: "items_name_idx",
    index_algorithm: "BTREE",
    is_unique: false,
    is_primary: false,
    column_name: "last_name,first_name",
    condition: "",
    include: "",
    comment: "",
  };
  const pgIndexEdit = (patch: Record<string, unknown>, original = index) =>
    generateSqlFromPatches(
      table("postgres", [], [original], {
        update: { constraints: { "0": patch } },
      }),
      "postgres"
    );

  it("does not drop an index for a no-op or comment-only edit", () => {
    expect(pgIndexEdit({ comment: "names" })).toEqual([]);
    expect(
      pgIndexEdit({ is_unique: "false", index_algorithm: "btree" })
    ).toEqual([]);
  });

  it("recreates a changed index with every column quoted", () => {
    expect(pgIndexEdit({ is_unique: "true" })).toEqual([
      'DROP INDEX IF EXISTS "shop"."items_name_idx";',
      'CREATE UNIQUE INDEX "items_name_idx" ON "shop"."items" USING BTREE ("last_name", "first_name");',
    ]);
  });

  it("refuses edits that would lose the primary key or index options", () => {
    expect(() =>
      pgIndexEdit({ is_unique: "true" }, { ...index, is_primary: true })
    ).toThrow(/primary key/);
    expect(() => pgIndexEdit({ condition: "active" })).toThrow(/condition/);
    expect(() =>
      pgIndexEdit({ is_unique: "true" }, { ...index, condition: "active" })
    ).toThrow(/lose its condition/);
  });

  it("MySQL: a crafted catalog default stays one quoted literal", () => {
    const [sql] = mysqlEdit(
      { data_type: "varchar(20)" },
      {
        ...mysqlColumn,
        column_name: "note",
        data_type: "varchar(10)",
        column_default: "'x'; DROP TABLE users; -- '",
        comment: "",
      }
    );
    expect(sql).toBe(
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `note` varchar(20) NOT NULL DEFAULT '''x''; DROP TABLE users; -- ''';"
    );
  });

  it("MySQL: refuses a column with attributes MODIFY would drop", () => {
    expect(() =>
      mysqlEdit({ data_type: "bigint" }, { ...mysqlColumn, extra: "INVISIBLE" })
    ).toThrow(/INVISIBLE/);
  });

  it("ClickHouse keeps its own MODIFY without restating defaults", () => {
    const sql = generateSqlFromPatches(
      table(
        "clickhouse",
        [{ ...mysqlColumn, column_default: "toDate(now())", comment: "" }],
        [],
        { update: { structure: { "0": { data_type: "Int64" } } } }
      ),
      "clickhouse"
    );
    expect(sql.join("\n")).not.toContain("toDate");
  });

  it("refuses recreating a MySQL index that has prefixes, a comment or expressions", () => {
    const mysqlIndexEdit = (original: Record<string, unknown>) =>
      generateSqlFromPatches(
        table("mysql", [], [{ ...index, ...original }], {
          update: { constraints: { "0": { is_unique: "true" } } },
        }),
        "mysql"
      );
    expect(() => mysqlIndexEdit({ has_prefix: true })).toThrow(/prefix/);
    expect(() => mysqlIndexEdit({ has_descending: true })).toThrow(
      /descending/
    );
    expect(() => mysqlIndexEdit({ comment: "hot path" })).toThrow(/comment/);
    expect(() =>
      mysqlIndexEdit({ has_expression: true, column_name: "" })
    ).toThrow(/expressions/);
    expect(mysqlIndexEdit({})).toHaveLength(2);
  });

  it("MySQL: no catalog default restates no DEFAULT at all", () => {
    const noDefault = {
      ...mysqlColumn,
      column_default: "",
      default_is_null: true,
      comment: "",
    };
    expect(mysqlEdit({ data_type: "bigint" }, noDefault)).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `qty` bigint NOT NULL;",
    ]);
    expect(
      mysqlEdit(
        { data_type: "bigint" },
        { ...noDefault, extra: "auto_increment" }
      )
    ).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `qty` bigint NOT NULL AUTO_INCREMENT;",
    ]);
    // A real empty-string default is kept.
    expect(
      mysqlEdit(
        { is_nullable: "YES" },
        {
          ...noDefault,
          column_name: "tag",
          data_type: "varchar(10)",
          default_is_null: false,
        }
      )
    ).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `tag` varchar(10) NULL DEFAULT '';",
    ]);
  });

  it("MySQL: a nullable TIMESTAMP is restated with an explicit NULL", () => {
    expect(
      mysqlEdit(
        { is_nullable: "YES" },
        {
          ...mysqlColumn,
          column_name: "seen_at",
          data_type: "timestamp",
          column_default: "CURRENT_TIMESTAMP",
          comment: "",
          extra: "DEFAULT_GENERATED",
        }
      )
    ).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `seen_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP;",
    ]);
  });

  it("MySQL: keeps number-looking text defaults on text columns", () => {
    expect(
      mysqlEdit(
        { is_nullable: "YES" },
        {
          ...mysqlColumn,
          column_name: "code",
          data_type: "varchar(5)",
          column_default: "001",
          comment: "",
        }
      )
    ).toEqual([
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `code` varchar(5) NULL DEFAULT '001';",
    ]);
  });

  it("refuses recreating a FULLTEXT index", () => {
    expect(() =>
      generateSqlFromPatches(
        table("mysql", [], [{ ...index, index_algorithm: "FULLTEXT" }], {
          update: { constraints: { "0": { index_name: "renamed" } } },
        }),
        "mysql"
      )
    ).toThrow(/FULLTEXT/);
  });

  it("renames a table to the trimmed name, and never to blank", () => {
    const rename = (tableName: string) =>
      generateSqlFromPatches(
        table("postgres", [], [], {
          update: { structure: { "-1": { tableName } } },
        }),
        "postgres"
      );
    expect(rename("  goods  ")).toEqual([
      'ALTER TABLE "shop"."items" RENAME TO "goods";',
    ]);
    expect(rename("   ")).toEqual([]);
    expect(rename(" items ")).toEqual([]);
  });

  it("generates no rename after undo on a name with spaces", () => {
    const padded = (tableName: string) =>
      generateSqlFromPatches(
        {
          "table:padded": {
            tableWindow: {
              id: "table:padded",
              type: "table",
              table: { schema: "shop", name: " items " },
            },
            tableData: {
              columns: [],
              structure: [],
              constraints: [],
              foreignKeys: [],
              sizeInfo: null,
              rowCount: 0,
              connectionId: "conn",
              busy: false,
              error: null,
            },
            patches: { update: { structure: { "-1": { tableName } } } },
          },
        } as unknown as PatchMap,
        "postgres"
      );
    expect(padded(" items ")).toEqual([]);
    expect(padded("items")).toEqual([
      'ALTER TABLE "shop"." items " RENAME TO "items";',
    ]);
  });

  it("refuses an index without columns instead of skipping it", () => {
    const createIndex = (column_name: string) =>
      generateSqlFromPatches(
        table("postgres", [], [index], {
          create: {
            constraints: {
              "1": {
                index_name: "items_new_idx",
                column_name,
                is_unique: "false",
                index_algorithm: "BTREE",
              },
            },
          },
        }),
        "postgres"
      );
    expect(() => createIndex("")).toThrow(/needs at least one column/);
    expect(() => createIndex(" , ")).toThrow(/needs at least one column/);
    expect(() => pgIndexEdit({ column_name: "" })).toThrow(
      /needs at least one column/
    );
    expect(() =>
      pgIndexEdit({ column_name: "", index_name: "renamed_idx" })
    ).toThrow(/needs at least one column/);
    // Editing a sibling field still keeps the existing columns.
    expect(pgIndexEdit({ is_unique: "true" })[1]).toContain(
      '("last_name", "first_name")'
    );
  });

  it("cancels a deleted empty draft index and keeps other changes", () => {
    const sql = generateSqlFromPatches(
      table("postgres", [], [index], {
        create: {
          constraints: {
            "1": { index_name: "", column_name: "", is_unique: "" },
          },
        },
        update: { constraints: { "0": { is_unique: "true" } } },
        delete: { constraints: { "1": {} } },
      }),
      "postgres"
    );
    expect(sql).toEqual([
      'DROP INDEX IF EXISTS "shop"."items_name_idx";',
      'CREATE UNIQUE INDEX "items_name_idx" ON "shop"."items" USING BTREE ("last_name", "first_name");',
    ]);
  });

  it("drops a deleted index even after its columns were cleared", () => {
    const sql = generateSqlFromPatches(
      table("postgres", [], [index], {
        update: { constraints: { "0": { column_name: "" } } },
        delete: { constraints: { "0": {} } },
      }),
      "postgres"
    );
    expect(sql).toEqual(['DROP INDEX IF EXISTS "shop"."items_name_idx";']);
  });

  it("MySQL: replaces the PRIMARY key in one statement", () => {
    const sql = generateSqlFromPatches(
      table(
        "mysql",
        [],
        [
          {
            ...index,
            index_name: "PRIMARY",
            column_name: "id",
            is_unique: true,
            is_primary: true,
          },
        ],
        { update: { structure: { "-1": { primaryKey: ["id", "tenant_id"] } } } }
      ),
      "mysql"
    );
    // One statement: MySQL DDL commits on its own, so a failing ADD must
    // not leave the table without a primary key.
    expect(sql).toEqual([
      "ALTER TABLE `shop`.`items` DROP PRIMARY KEY, ADD PRIMARY KEY (`id`, `tenant_id`);",
    ]);
  });

  it("PostgreSQL: finds the primary key by its flag, whatever its name", () => {
    const change = (name: string, primaryKey: string[]) =>
      generateSqlFromPatches(
        table(
          "postgres",
          [],
          [
            {
              ...index,
              index_name: name,
              column_name: "id",
              is_unique: true,
              is_primary: true,
            },
          ],
          { update: { structure: { "-1": { primaryKey } } } }
        ),
        "postgres"
      );
    expect(change("items_pkey", ["code"])).toEqual([
      'ALTER TABLE "shop"."items" DROP CONSTRAINT IF EXISTS "items_pkey";',
      'ALTER TABLE "shop"."items" ADD PRIMARY KEY ("code");',
    ]);
    // A renamed primary key constraint is still the primary key.
    expect(change("items_main", ["code"])[0]).toBe(
      'ALTER TABLE "shop"."items" DROP CONSTRAINT IF EXISTS "items_main";'
    );
    // The same columns are no change.
    expect(change("items_pkey", ["id"])).toEqual([]);
  });

  it("changes the flagged primary key, not a UNIQUE index named like one", () => {
    const constraints = [
      {
        ...index,
        index_name: "primary_email",
        column_name: "email",
        is_unique: true,
        is_primary: false,
      },
      {
        ...index,
        index_name: "items_main",
        column_name: "id",
        is_unique: true,
        is_primary: true,
      },
    ];
    const pk = (primaryKey: string[]) =>
      generateSqlFromPatches(
        table("postgres", [], constraints, {
          update: { structure: { "-1": { primaryKey } } },
        }),
        "postgres"
      );
    expect(pk([])).toEqual([
      'ALTER TABLE "shop"."items" DROP CONSTRAINT IF EXISTS "items_main";',
    ]);
    expect(pk(["code"])[0]).toBe(
      'ALTER TABLE "shop"."items" DROP CONSTRAINT IF EXISTS "items_main";'
    );
    expect(pk(["id"])).toEqual([]);
  });

  it("MySQL: clearing the primary key drops it alone", () => {
    expect(
      generateSqlFromPatches(
        table(
          "mysql",
          [],
          [
            {
              ...index,
              index_name: "PRIMARY",
              column_name: "id",
              is_primary: true,
            },
          ],
          { update: { structure: { "-1": { primaryKey: [] } } } }
        ),
        "mysql"
      )
    ).toEqual(["ALTER TABLE `shop`.`items` DROP PRIMARY KEY;"]);
  });

  it("ClickHouse: refuses primary key changes, keeps a no-op quiet", () => {
    const pk = (primaryKey: string[]) =>
      generateSqlFromPatches(
        table(
          "clickhouse",
          [],
          [
            {
              ...index,
              index_name: "PRIMARY",
              column_name: "id",
              is_primary: true,
            },
          ],
          { update: { structure: { "-1": { primaryKey } } } }
        ),
        "clickhouse"
      );
    expect(() => pk([])).toThrow(/primary key/i);
    expect(() => pk(["id", "ts"])).toThrow(/primary key/i);
    expect(pk(["id"])).toEqual([]);
  });

  it("refuses deleting the primary key's index, allows other indexes", () => {
    const drop = (engine: string, constraints: Record<string, unknown>[]) =>
      generateSqlFromPatches(
        table(engine, [], constraints, {
          delete: { constraints: { "0": {} } },
        }),
        engine as never
      );
    expect(() =>
      drop("mysql", [
        {
          ...index,
          index_name: "PRIMARY",
          column_name: "id",
          is_primary: true,
        },
      ])
    ).toThrow(/Clear Primary/);
    expect(() =>
      drop("postgres", [
        {
          ...index,
          index_name: "items_pkey",
          column_name: "id",
          is_primary: true,
        },
      ])
    ).toThrow(/Clear Primary/);
    expect(drop("postgres", [index])).toEqual([
      'DROP INDEX IF EXISTS "shop"."items_name_idx";',
    ]);
  });

  it("PostgreSQL: a UNIQUE constraint named PRIMARY is an ordinary index", () => {
    const uniquePrimary = {
      ...index,
      index_name: "PRIMARY",
      column_name: "email",
      is_unique: true,
      is_primary: false,
    };
    const run = (patches: unknown) =>
      generateSqlFromPatches(
        table("postgres", [], [uniquePrimary], patches),
        "postgres"
      );
    // No primary key to clear; adding one only adds.
    expect(
      run({ update: { structure: { "-1": { primaryKey: [] } } } })
    ).toEqual([]);
    expect(
      run({ update: { structure: { "-1": { primaryKey: ["id"] } } } })
    ).toEqual(['ALTER TABLE "shop"."items" ADD PRIMARY KEY ("id");']);
    // It can be edited and dropped like any index.
    expect(run({ delete: { constraints: { "0": {} } } })).toEqual([
      'DROP INDEX IF EXISTS "shop"."PRIMARY";',
    ]);
    expect(
      run({ update: { constraints: { "0": { is_unique: "false" } } } })
    ).toHaveLength(2);
  });
});
