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

beforeEach(() => {
  m.runSqlQuery.mockReset();
});

describe("buildPostgresTypesSql", () => {
  it("creates the schemas, enums and domains the tables use", async () => {
    m.runSqlQuery
      // Enums.
      .mockResolvedValueOnce({
        rows: [["public", "user_role", "'customer', 'admin'"]],
      })
      // Domains.
      .mockResolvedValueOnce({
        rows: [
          [
            "billing",
            "positive_amount",
            "numeric(12,2)",
            true,
            "0",
            "CONSTRAINT positive CHECK (VALUE >= 0)",
          ],
        ],
      });

    const sql = await buildPostgresTypesSql({
      connectionId: "c1",
      tables: [
        { schema: "public", name: "users" },
        { schema: "sales", name: "orders" },
      ],
    });

    expect(sql).toBe(
      [
        'CREATE SCHEMA IF NOT EXISTS "billing";',
        'CREATE SCHEMA IF NOT EXISTS "sales";',
        `CREATE TYPE "public"."user_role" AS ENUM ('customer', 'admin');`,
        'CREATE DOMAIN "billing"."positive_amount" AS numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT positive CHECK (VALUE >= 0);',
        "",
      ].join("\n")
    );
    // Both lookups are limited to the backed-up tables.
    for (const [, query] of m.runSqlQuery.mock.calls) {
      expect(query).toContain(`('public', 'users'), ('sales', 'orders')`);
    }
  });

  it("adds nothing when the tables use only built-in types", async () => {
    m.runSqlQuery.mockResolvedValue({ rows: [] });
    const sql = await buildPostgresTypesSql({
      connectionId: "c1",
      tables: [{ schema: "public", name: "users" }],
    });
    expect(sql).toBe("");
  });
});
