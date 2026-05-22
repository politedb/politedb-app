import type { DatabaseEngine } from "src/types";

export function isSqliteLike(
  engine?: DatabaseEngine | string | null
): engine is "sqlite" | "d1" | "turso" | "duckdb" {
  return (
    engine === "sqlite" ||
    engine === "d1" ||
    engine === "turso" ||
    engine === "duckdb"
  );
}
