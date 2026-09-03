import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { runSqlQuery } from "src/lib/tauri/query";
import { loadDiagramState } from "./diagramMetadata";

vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: vi.fn() }));

const runSqlQueryMock = vi.mocked(runSqlQuery);

describe("loadDiagramState", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads a PostgreSQL schema in two metadata queries", async () => {
    const metadata = {
      load: vi.fn().mockResolvedValue({
        columnsLoaded: true,
        tables: [
          { schema: "public", name: "users" },
          { schema: "public", name: "orders" },
        ],
        columnsByTable: {},
        columnDetailsByTable: {
          "public.users": [{ name: "id", dataType: "uuid" }],
          "public.orders": [
            { name: "id", dataType: "uuid" },
            { name: "user_id", dataType: "uuid" },
          ],
        },
      }),
    } as unknown as MetadataApi;
    runSqlQueryMock
      .mockResolvedValueOnce({
        columns: [],
        rowCount: 1,
        rows: [
          [
            "orders_user_id_fkey",
            "public",
            "orders",
            "user_id",
            "public",
            "users",
            "id",
            "NO ACTION",
            "CASCADE",
          ],
        ],
      })
      .mockResolvedValueOnce({
        columns: [],
        rowCount: 2,
        rows: [
          ["users", true, "id"],
          ["orders", true, "id"],
        ],
      });

    const state = await loadDiagramState({
      metadata,
      metaKey: "postgres:test",
      connectionId: "connection-1",
      engine: "postgres",
      schema: "public",
    });

    expect(runSqlQueryMock).toHaveBeenCalledTimes(2);
    expect(state.tableCount).toBe(2);
    expect(state.relationshipCount).toBe(1);
    expect(state.tables[0]?.columns[0]?.isPrimaryKey).toBe(true);
    expect(state.relations[0]?.cardinality).toBe("one-to-many");
  });
});
