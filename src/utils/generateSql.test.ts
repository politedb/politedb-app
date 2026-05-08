import { describe, expect, it } from "vitest";
import { generateUpdateSqlFromPatches } from "./generateSql";

function mysqlJsonDisplayLiteral(value: unknown) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const mysqlSafeJson = json.replace(/'/g, "\\u0027");
  return `'${mysqlSafeJson
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")}'`;
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
    expect(sql[0]).toContain("password");
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
    expect(sql[0]).toContain(']}}');
    expect(sql[0]).toContain("WHERE `id` = 1;");
  });

  it("replaces apostrophes in MySQL JSON payload with unicode escape", () => {
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
    expect(sql[0]).toContain("\\u0027");
    expect(sql[0]).not.toContain("[\\\"\\']");
  });
});
