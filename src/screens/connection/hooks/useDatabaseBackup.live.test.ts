/**
 * Live backup → restore checks against a disposable PostgreSQL container
 * (never a customer database), run with
 * `POLITEDB_LIVE_PG_CONTAINER=<container> npx vitest run useDatabaseBackup.live`.
 * They create and drop the databases politedb_live_src and politedb_live_dst.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const container = process.env.POLITEDB_LIVE_PG_CONTAINER;

function psql(db: string, sql: string, csv = false): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container!,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      ...(csv ? ["--csv"] : []),
    ],
    { input: sql, encoding: "utf8" }
  );
}

/** psql --csv rows; an unquoted empty field is NULL. */
function parseCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  const end = () => {
    row.push(!wasQuoted && field === "" ? null : field);
    field = "";
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (c === ",") end();
    else if (c === "\n") {
      end();
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) {
    end();
    rows.push(row);
  }
  return rows;
}

async function liveQuery(_c: string, sql: string) {
  return {
    rows: parseCsv(psql("politedb_live_src", sql, true)).map((r) =>
      r.map((v) => (v === null ? { t: "Null" } : { t: "Str", v }))
    ),
  };
}
vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: vi.fn(),
  runSqlQuery: liveQuery,
}));
// Catalog queries go through the dump port; here they reach runSqlQuery.
vi.mock("src/lib/tauri/dumpOperation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/lib/tauri/dumpOperation")>();
  return {
    ...actual,
    dumpQuery: (c: string, sql: string) => {
      const result = Promise.resolve().then(() => liveQuery(c, sql));
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

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import {
  buildPostgresTableStructure,
  buildPostgresTypesSql,
} from "./useDatabaseBackup";

describe.skipIf(!container)("PostgreSQL backup → restore (live)", () => {
  beforeAll(() => {
    psql("postgres", "DROP DATABASE IF EXISTS politedb_live_src;");
    psql("postgres", "DROP DATABASE IF EXISTS politedb_live_dst;");
    psql("postgres", "CREATE DATABASE politedb_live_src;");
    psql("postgres", "CREATE DATABASE politedb_live_dst;");
  });
  afterAll(() => {
    psql("postgres", "DROP DATABASE IF EXISTS politedb_live_src;");
    psql("postgres", "DROP DATABASE IF EXISTS politedb_live_dst;");
  });

  it("keeps a serial's options when a domain default created its sequence first", async () => {
    psql(
      "politedb_live_src",
      `CREATE SCHEMA app;
       CREATE SEQUENCE app.t_id_seq AS integer INCREMENT BY -10
         MINVALUE -1000 MAXVALUE -1 START WITH -1 CACHE 7 CYCLE;
       CREATE DOMAIN app.next_id AS integer DEFAULT nextval('app.t_id_seq');
       CREATE TABLE app.t (
         id integer NOT NULL DEFAULT nextval('app.t_id_seq'),
         d app.next_id,
         v text
       );
       ALTER SEQUENCE app.t_id_seq OWNED BY app.t.id;
       INSERT INTO app.t (v) VALUES ('a'), ('b'), ('c');`
    );
    const types = await buildPostgresTypesSql({
      connectionId: "c",
      tables: [{ schema: "app", name: "t" }],
    });
    // The domain's sequence comes first, bare.
    expect(types).toMatch(/CREATE SEQUENCE IF NOT EXISTS "app"\."t_id_seq"/);
    const table = await buildPostgresTableStructure({
      connectionId: "c",
      schema: "app",
      tableName: "t",
    });
    const rows = psql(
      "politedb_live_src",
      "SELECT format('(%s, %s, %L)', id, d, v) FROM app.t ORDER BY id DESC;"
    )
      .trim()
      .split("\n")
      .join(", ");
    psql(
      "politedb_live_dst",
      types +
        table.preDataSql +
        `INSERT INTO "app"."t" ("id", "d", "v") VALUES ${rows};\n` +
        table.postDataSql +
        table.sequenceValuesSql
    );
    const next = (db: string) =>
      psql(
        db,
        `SELECT nextval('app.t_id_seq'), seqincrement, seqmin, seqmax, seqcache, seqcycle
         FROM pg_sequence WHERE seqrelid = 'app.t_id_seq'::regclass;`
      ).trim();
    expect(next("politedb_live_dst")).toBe(next("politedb_live_src"));
  });
});
