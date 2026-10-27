import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ runSqlQuery: vi.fn() }));
vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: vi.fn(),
  runSqlQuery: m.runSqlQuery,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { buildPostgresTypesSql } from "./useDatabaseBackup";

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
