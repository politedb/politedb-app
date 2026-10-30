import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ runSqlQuery: vi.fn() }));
// Catalog queries go through the dump port; here they reach runSqlQuery.
vi.mock("src/lib/tauri/dumpOperation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/lib/tauri/dumpOperation")>();
  return {
    ...actual,
    dumpQuery: (c: string, sql: string, o: unknown) => {
      const result = Promise.resolve().then(() => m.runSqlQuery(c, sql, o));
      return {
        result,
        cancel: async () => ({ kind: "requested" }),
        settled: result.then(
          () => ({ kind: "server-finished" }),
          (error: unknown) => ({ kind: "server-finished", error })
        ),
      };
    },
  };
});
vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: vi.fn(),
  runSqlQuery: m.runSqlQuery,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import {
  buildPostgresTableStructure,
  buildPostgresTypesSql,
  postgresGeneratedOnlyRowsSql,
  dumpCommentName,
  postgresBackupRowsQuery,
  postgresMoneyColumns,
} from "./useDatabaseBackup";
import {
  formatSqlInsertChunk,
  POSTGRES_MONEY_ARRAY_AS_NUMERIC,
  POSTGRES_MONEY_AS_NUMERIC,
} from "./sqlInsertLiteral";
import { splitSqlStatements } from "src/components/editor/splitSqlStatements";

/** One catalog row, in the query's column order. */
function row(p: {
  oid: string;
  schema?: string;
  name: string;
  kind: "e" | "d" | "b";
  baseSql?: string;
  baseOid?: string;
  notNull?: boolean;
  defaultExpr?: string;
  checks?: string;
  labels?: string;
  collation?: string;
  collationDef?: string;
  collationSchema?: string;
  collationName?: string;
  extension?: string;
  extensionSchema?: string;
  sequences?: string;
  collationExtension?: string;
  collationExtensionSchema?: string;
}) {
  return [
    p.oid,
    p.schema ?? "public",
    p.name,
    p.kind,
    p.baseSql ?? null,
    p.baseOid ?? null,
    p.notNull ?? false,
    p.defaultExpr ?? null,
    p.checks ?? null,
    p.labels ?? null,
    p.collation ?? null,
    p.collationDef ?? null,
    p.collationSchema ?? null,
    p.collationName ?? null,
    p.extension ?? null,
    p.extensionSchema ?? null,
    p.sequences ?? null,
    p.collationExtension ?? null,
    p.collationExtensionSchema ?? null,
  ];
}

async function build(
  rows: unknown[][],
  tables = [{ schema: "public", name: "t" }]
) {
  m.runSqlQuery.mockResolvedValueOnce({ rows });
  return buildPostgresTypesSql({ connectionId: "c1", tables });
}

beforeEach(() => m.runSqlQuery.mockReset());

describe("buildPostgresTypesSql", () => {
  it("creates schemas, enums and domains, each domain after its base", async () => {
    const sql = await build(
      [
        // Sorted by name, the child comes first; it must be created last.
        row({
          oid: "3",
          name: "a_child",
          kind: "d",
          baseSql: "z_parent",
          baseOid: "2",
        }),
        row({
          oid: "4",
          schema: "other",
          name: "role",
          kind: "e",
          labels: "'a', 'b'",
        }),
        row({
          oid: "2",
          name: "z_parent",
          kind: "d",
          baseSql: "other.role",
          baseOid: "4",
          notNull: true,
        }),
      ],
      [
        { schema: "public", name: "t" },
        { schema: "sales", name: "orders" },
      ]
    );
    expect(sql).toBe(
      [
        'CREATE SCHEMA IF NOT EXISTS "other";',
        'CREATE SCHEMA IF NOT EXISTS "sales";',
        `CREATE TYPE "other"."role" AS ENUM ('a', 'b');`,
        'CREATE DOMAIN "public"."z_parent" AS other.role NOT NULL;',
        'CREATE DOMAIN "public"."a_child" AS z_parent;',
        "",
      ].join("\n")
    );
    // The lookup is limited to the backed-up tables.
    expect(m.runSqlQuery.mock.calls[0]![1]).toContain(
      `('public', 't'), ('sales', 'orders')`
    );
  });

  it("keeps a domain's collation, default, NOT NULL and CHECKs", async () => {
    const sql = await build([
      row({
        oid: "5",
        name: "code",
        kind: "d",
        baseSql: "text",
        collation: '"pg_catalog"."C"',
        defaultExpr: "'x'::text",
        notNull: true,
        checks: "CONSTRAINT short CHECK ((length(VALUE) < 10))",
      }),
    ]);
    expect(sql).toBe(
      `CREATE DOMAIN "public"."code" AS text COLLATE "pg_catalog"."C" DEFAULT 'x'::text NOT NULL CONSTRAINT short CHECK ((length(VALUE) < 10));\n`
    );
  });

  it("creates the sequences a domain default uses before the domain", async () => {
    const sql = await build([
      row({
        oid: "6",
        name: "ticket",
        kind: "d",
        baseSql: "integer",
        defaultExpr: "nextval('users_id_seq'::regclass)",
        sequences: JSON.stringify([{ schema: "public", name: "users_id_seq" }]),
      }),
    ]);
    expect(sql).toBe(
      [
        'CREATE SEQUENCE IF NOT EXISTS "public"."users_id_seq";',
        `CREATE DOMAIN "public"."ticket" AS integer DEFAULT nextval('users_id_seq'::regclass);`,
        "",
      ].join("\n")
    );
  });

  it("creates a sequence's own schema, and keeps commas in its name", async () => {
    const sql = await build([
      row({
        oid: "11",
        name: "ticket",
        kind: "d",
        baseSql: "integer",
        defaultExpr: "nextval('archive.\"ids,old\"'::regclass)",
        sequences: JSON.stringify([{ schema: "archive", name: "ids,old" }]),
      }),
    ]);
    expect(sql).toBe(
      [
        'CREATE SCHEMA IF NOT EXISTS "archive";',
        'CREATE SEQUENCE IF NOT EXISTS "archive"."ids,old";',
        `CREATE DOMAIN "public"."ticket" AS integer DEFAULT nextval('archive."ids,old"'::regclass);`,
        "",
      ].join("\n")
    );
  });

  it.each([
    [
      "an ICU collation (PostgreSQL 17)",
      {
        collprovider: "i",
        colllocale: "und-u-ks-level2",
        collisdeterministic: false,
      },
      `(provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
    ],
    [
      "an ICU collation (PostgreSQL 15–16)",
      { collprovider: "i", colliculocale: "de-DE", collisdeterministic: true },
      `(provider = icu, locale = 'de-DE')`,
    ],
    [
      "a builtin collation (PostgreSQL 17)",
      { collprovider: "b", colllocale: "C.UTF-8", collisdeterministic: true },
      `(provider = builtin, locale = 'C.UTF-8')`,
    ],
    [
      "a libc collation",
      {
        collprovider: "c",
        collcollate: "C",
        collctype: "C",
        collisdeterministic: true,
      },
      `(provider = libc, lc_collate = 'C', lc_ctype = 'C')`,
    ],
  ])("recreates %s a domain uses", async (_c, def, options) => {
    const sql = await build([
      row({
        oid: "12",
        name: "code",
        kind: "d",
        baseSql: "text",
        collation: '"custom"."ordering"',
        collationDef: JSON.stringify(def),
        collationSchema: "custom",
        collationName: "ordering",
      }),
    ]);
    expect(sql).toBe(
      [
        'CREATE SCHEMA IF NOT EXISTS "custom";',
        `CREATE COLLATION IF NOT EXISTS "custom"."ordering" ${options};`,
        'CREATE DOMAIN "public"."code" AS text COLLATE "custom"."ordering";',
        "",
      ].join("\n")
    );
  });

  it("refuses a collation provider it cannot recreate", async () => {
    await expect(
      build([
        row({
          oid: "13",
          name: "code",
          kind: "d",
          baseSql: "text",
          collation: '"custom"."odd"',
          collationDef: JSON.stringify({ collprovider: "x" }),
          collationSchema: "custom",
          collationName: "odd",
        }),
      ])
    ).rejects.toThrow("custom.odd uses a provider backups cannot recreate");
  });

  it("installs the extension owning a domain's collation instead of copying it", async () => {
    const sql = await build([
      row({
        oid: "14",
        name: "code",
        kind: "d",
        baseSql: "text",
        collation: '"ext"."nice"',
        collationDef: JSON.stringify({ collprovider: "i", colllocale: "und" }),
        collationSchema: "ext",
        collationName: "nice",
        collationExtension: "nicecoll",
        collationExtensionSchema: "ext",
      }),
    ]);
    expect(sql).toBe(
      [
        'CREATE SCHEMA IF NOT EXISTS "ext";',
        'CREATE EXTENSION IF NOT EXISTS "nicecoll" WITH SCHEMA "ext";',
        'CREATE DOMAIN "public"."code" AS text COLLATE "ext"."nice";',
        "",
      ].join("\n")
    );
  });

  it("installs the extension owning a type instead of recreating it", async () => {
    const sql = await build([
      row({
        oid: "7",
        name: "citext",
        kind: "b",
        extension: "citext",
        extensionSchema: "public",
      }),
      row({
        oid: "8",
        name: "earth",
        kind: "d",
        baseSql: "cube",
        extension: "earthdistance",
        extensionSchema: "ext",
      }),
      // A user domain over an extension type is still the user's.
      row({
        oid: "9",
        name: "email",
        kind: "d",
        baseSql: "citext",
        baseOid: "7",
      }),
    ]);
    expect(sql).toBe(
      [
        'CREATE SCHEMA IF NOT EXISTS "ext";',
        'CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public";',
        'CREATE EXTENSION IF NOT EXISTS "earthdistance" WITH SCHEMA "ext";',
        'CREATE DOMAIN "public"."email" AS citext;',
        "",
      ].join("\n")
    );
  });

  it("keeps an enum with no labels", async () => {
    const sql = await build([
      row({ oid: "10", name: "pending", kind: "e", labels: "" }),
    ]);
    expect(sql).toBe('CREATE TYPE "public"."pending" AS ENUM ();\n');
  });

  it("adds nothing when the tables use only built-in types", async () => {
    expect(await build([])).toBe("");
  });
});

describe("dumpCommentName", () => {
  it("keeps a name with line breaks inside its comment line", () => {
    const name = "x\nDROP TABLE victim;--\r\nmore";
    const header = `-- Structure ${dumpCommentName("public", name)}`;
    expect(header).toBe("-- Structure public.x DROP TABLE victim;--  more");
    const dump = `${header}\nCREATE TABLE IF NOT EXISTS "public"."x\nDROP TABLE victim;--" (v text);`;
    const statements = splitSqlStatements(dump, { dialect: "postgres" });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.text).toContain("CREATE TABLE IF NOT EXISTS");
  });
});

describe("postgresBackupRowsQuery", () => {
  it("reads every column through its output function, names quoted", () => {
    expect(postgresBackupRowsQuery("App", 'we"ird', ["id", "a = b"])).toBe(
      'SELECT CASE WHEN num_nulls("id") = 1 THEN NULL ELSE format(\'%s\', "id") END AS "id", ' +
        'CASE WHEN num_nulls("a = b") = 1 THEN NULL ELSE format(\'%s\', "a = b") END AS "a = b" ' +
        'FROM "App"."we""ird";'
    );
  });

  it("reads money and money[] as numeric", () => {
    expect(
      postgresBackupRowsQuery("s", "t", ["m", "ms"], {
        scalar: new Set(["m"]),
        array: new Set(["ms"]),
      })
    ).toBe(
      'SELECT CASE WHEN num_nulls("m") = 1 THEN NULL ELSE ("m")::numeric::text END AS "m", ' +
        'CASE WHEN num_nulls("ms") = 1 THEN NULL ELSE ("ms")::numeric[]::text END AS "ms" FROM "s"."t";'
    );
  });

  it("writes money read as numeric as a typed numeric, checking decimal places", () => {
    const sql = formatSqlInsertChunk({
      engine: "postgres",
      schema: "s",
      tableName: "t",
      columnNames: ["m", "ms", "z", "x"],
      columnTypes: [
        POSTGRES_MONEY_AS_NUMERIC,
        POSTGRES_MONEY_ARRAY_AS_NUMERIC,
        POSTGRES_MONEY_AS_NUMERIC,
        "text",
      ],
      rows: [
        [
          { t: "Str", v: "-1234.56" },
          { t: "Str", v: "[0:1]={1.500,NULL}" },
          { t: "Str", v: "1235" },
          { t: "Str", v: "1234.56" },
        ],
      ],
      qIdent: (name) => `"${name}"`,
    });
    const here = "scale('0'::money::numeric)";
    expect(sql).toContain(
      `CASE WHEN ${here} >= 2 THEN '-1234.56'::numeric ELSE ('money here keeps ' || ${here} || ' decimal places, the backup has 2: restore with a matching lc_monetary')::numeric END`
    );
    expect(sql).toContain(
      `CASE WHEN ${here} >= 3 THEN '[0:1]={1.500,NULL}'::numeric[] ELSE`
    );
    // No decimal places: nothing to round.
    expect(sql).toContain(`, '1235'::numeric, '1234.56')`);
    expect(
      splitSqlStatements(`${sql}\nSELECT 2;`, { dialect: "postgres" })
    ).toHaveLength(2);
  });

  it("stops at money inside another type, and reads where money is", async () => {
    const lastSql = () =>
      m.runSqlQuery.mock.calls[m.runSqlQuery.mock.calls.length - 1]![1];
    const version = (v14: boolean) =>
      m.runSqlQuery.mockResolvedValueOnce({ rows: [[{ t: "Bool", v: v14 }]] });
    version(true);
    m.runSqlQuery.mockResolvedValueOnce({
      rows: [
        [
          { t: "Str", v: "m" },
          { t: "Str", v: "" },
        ],
        [
          { t: "Str", v: "ms" },
          { t: "Str", v: "a" },
        ],
      ],
    });
    expect(await postgresMoneyColumns("c1", "s", "t")).toEqual({
      scalar: new Set(["m"]),
      array: new Set(["ms"]),
    });
    expect(lastSql()).toContain("rngmultitypid");

    // PostgreSQL 13 has no multiranges: the walk must not name them.
    version(false);
    m.runSqlQuery.mockResolvedValueOnce({ rows: [] });
    await postgresMoneyColumns("c1", "s", "t");
    expect(lastSql()).not.toContain("rngmultitypid");

    version(true);
    m.runSqlQuery.mockResolvedValueOnce({
      rows: [
        [
          { t: "Str", v: "addr" },
          { t: "Str", v: "c" },
        ],
      ],
    });
    await expect(postgresMoneyColumns("c1", "s", "t")).rejects.toThrow(
      /"addr" .* holds money inside another type/
    );

    // A walk cut at the depth limit is not taken as money-free.
    version(true);
    m.runSqlQuery.mockResolvedValueOnce({
      rows: [
        [
          { t: "Str", v: "deep" },
          { t: "Str", v: "!" },
        ],
      ],
    });
    await expect(postgresMoneyColumns("c1", "s", "t")).rejects.toThrow(
      /"deep" .* nested too deeply/
    );
  });

  it("writes the text values as literals the column types", () => {
    // Text forms of a composite, a bytea array and hstore, as read.
    const sql = formatSqlInsertChunk({
      engine: "postgres",
      schema: "app",
      tableName: "t",
      columnNames: ["c", "bya", "h"],
      columnTypes: ["text", "text", "text"],
      rows: [
        [
          { t: "Str", v: '("Main ""St"", 1\\2",70000)' },
          { t: "Str", v: '{"\\x00",NULL}' },
          { t: "Null" },
        ],
      ],
      qIdent: (name) => `"${name}"`,
    });
    expect(sql).toContain(
      String.raw`VALUES
  (E'("Main ""St"", 1\\2",70000)', E'{"\\x00",NULL}', NULL);`
    );
    expect(
      splitSqlStatements(`${sql}\nSELECT 2;`, { dialect: "postgres" })
    ).toHaveLength(2);
  });
});

describe("buildPostgresTableStructure: generated and identity columns", () => {
  const S = (v: string | null) =>
    v === null ? { t: "Null" } : { t: "Str", v };

  function catalog(opts: { unreadable?: boolean } = {}) {
    m.runSqlQuery.mockImplementation(async (_c: string, sql = "") => {
      if (sql.includes("SELECT c.oid")) return { rows: [[S("42")]] };
      if (sql.includes("format_type(a.atttypid"))
        return {
          rows: [
            [S("id"), S("integer"), S("t"), S(null), S("a"), S("")],
            [S("bid"), S("bigint"), S("t"), S(null), S("d"), S("")],
            [S("price"), S("numeric"), S("f"), S(null), S(""), S("")],
            [S("total"), S("numeric"), S("f"), S("(price * 2)"), S(""), S("s")],
            [S("half"), S("numeric"), S("f"), S("(price / 2)"), S(""), S("v")],
          ],
        };
      if (sql.includes("FROM pg_sequence s")) {
        const id = sql.includes("'id'");
        return {
          rows: [
            [
              S(id ? "app.g_id_seq" : "app.g_bid_seq"),
              S(id ? "-1" : "1"),
              S(id ? "-10" : "1"),
              S(id ? "-1000" : "1"),
              S(id ? "-1" : "9223372036854775807"),
              S("1"),
              S(id ? "t" : "f"),
              S(id ? "integer" : "bigint"),
            ],
          ],
        };
      }
      if (sql.includes("last_value")) {
        if (opts.unreadable) throw new Error("permission denied");
        const id = sql.includes("g_id_seq");
        return { rows: [[S(id ? "-21" : "1"), S(id ? "t" : "f")]] };
      }
      return { rows: [] };
    });
  }

  it("recreates them with their sequence options, and sets the sequences", async () => {
    catalog();
    const s = await buildPostgresTableStructure({
      connectionId: "c1",
      schema: "app",
      tableName: "g",
    });
    expect(s.preDataSql).toContain(
      '"id" integer GENERATED ALWAYS AS IDENTITY (INCREMENT BY -10 MINVALUE -1000 MAXVALUE -1 START WITH -1 CACHE 1 CYCLE) NOT NULL'
    );
    expect(s.preDataSql).toContain(
      '"bid" bigint GENERATED BY DEFAULT AS IDENTITY (INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE) NOT NULL'
    );
    expect(s.preDataSql).toContain(
      '"total" numeric GENERATED ALWAYS AS ((price * 2)) STORED'
    );
    expect(s.preDataSql).toContain(
      '"half" numeric GENERATED ALWAYS AS ((price / 2)) VIRTUAL'
    );
    // Set again even when the CREATE is skipped (an existing table or
    // sequence), before any row.
    expect(s.preDataSql).toContain(
      'ALTER TABLE "app"."g" ALTER COLUMN "id" SET INCREMENT BY -10 SET MINVALUE -1000 SET MAXVALUE -1 SET START WITH -1 SET CACHE 1 SET CYCLE RESTART;'
    );
    expect(s.preDataSql.indexOf("ALTER TABLE")).toBeGreaterThan(
      s.preDataSql.indexOf("CREATE TABLE")
    );
    expect(s.generatedColumns).toEqual(["total", "half"]);
    expect(s.identityAlways).toBe(true);
    expect(s.allGenerated).toBe(false);
    expect(s.sequenceValuesSql).toBe(
      `SELECT pg_catalog.setval(pg_get_serial_sequence('"app"."g"', 'id'), -21, true);\n` +
        `SELECT pg_catalog.setval(pg_get_serial_sequence('"app"."g"', 'bid'), 1, false);\n`
    );
  });

  it("stops the backup when a sequence cannot be read", async () => {
    catalog({ unreadable: true });
    await expect(
      buildPostgresTableStructure({
        connectionId: "c1",
        schema: "app",
        tableName: "g",
      })
    ).rejects.toThrow(/sequence numbering "id" of app\.g could not be read/);
  });

  it("passes a cancel on as a cancel, not as an unreadable sequence", async () => {
    catalog();
    const base = m.runSqlQuery.getMockImplementation()!;
    m.runSqlQuery.mockImplementation(async (c: string, sql = "") => {
      if (sql.includes("last_value")) {
        // What the dump port rejects with once the job cancels the query.
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      return base(c, sql);
    });
    const built = buildPostgresTableStructure({
      connectionId: "c1",
      schema: "app",
      tableName: "g",
    });
    await expect(built).rejects.toMatchObject({ name: "AbortError" });
    await expect(built).rejects.not.toThrow(/could not be read/);
  });

  it("restores the rows of a table of generated columns by count", async () => {
    m.runSqlQuery.mockResolvedValueOnce({ rows: [[S("3")]] });
    expect(await postgresGeneratedOnlyRowsSql("c1", "app", "g")).toBe(
      'INSERT INTO "app"."g" SELECT FROM generate_series(1, 3);\n'
    );
    m.runSqlQuery.mockResolvedValueOnce({ rows: [[S("0")]] });
    expect(await postgresGeneratedOnlyRowsSql("c1", "app", "g")).toBe("");
  });

  it("writes OVERRIDING SYSTEM VALUE for a GENERATED ALWAYS identity", () => {
    expect(
      formatSqlInsertChunk({
        engine: "postgres",
        schema: "app",
        tableName: "g",
        columnNames: ["id"],
        rows: [[{ t: "Str", v: "1" }]],
        qIdent: (name) => `"${name}"`,
        overridingSystemValue: true,
      })
    ).toBe(
      `INSERT INTO "app"."g" ("id") OVERRIDING SYSTEM VALUE VALUES\n  ('1');\n`
    );
  });
});

describe("catalog queries", () => {
  it("quote a name holding a backslash as an E'' literal", async () => {
    m.runSqlQuery
      .mockResolvedValueOnce({ rows: [[{ t: "Bool", v: true }]] })
      .mockResolvedValueOnce({ rows: [] });
    await postgresMoneyColumns("c1", "s\\'x", "t");
    const sql = m.runSqlQuery.mock.calls[1]![1] as string;
    // With standard_conforming_strings off a plain '…' would end at \'.
    expect(sql).toContain(String.raw`n.nspname = E's\\''x'`);
    expect(sql).toContain("c.relname = 't'");
  });
});
