import type { DatabaseEngine } from "src/types";

export function isSqliteLike(
  engine?: DatabaseEngine | string | null
): engine is "sqlite" | "d1" {
  return engine === "sqlite" || engine === "d1";
}
