import type { DatabaseEngine } from "src/types";
import { isNonSqlPatchEngine as isNonSqlPatchEngineFromRegistry } from "src/lib/engines";
import { applyCassandraPatchEntry } from "./applyCassandraPatch";
import { applyMongoPatchEntry } from "./applyMongoPatch";
import { applyRedisPatchEntry } from "./applyRedisPatch";
import type { PatchApplyContext, PatchMapEntry } from "./types";

export * from "./generateSql";
export type { PatchApplyContext, PatchMapEntry } from "./types";
export { mongoCellToValue, patchValueToString } from "./types";

export async function applyNonSqlPatchEntry(
  engine: DatabaseEngine,
  entry: PatchMapEntry,
  ctx: PatchApplyContext
): Promise<void> {
  switch (engine) {
    case "mongo":
      return applyMongoPatchEntry(entry, ctx);
    case "cassandra":
      return applyCassandraPatchEntry(entry, ctx);
    case "redis":
      return applyRedisPatchEntry(entry, ctx);
    default:
      throw new Error(`Engine "${engine}" does not use non-SQL patch apply.`);
  }
}

export function isNonSqlPatchEngine(
  engine: DatabaseEngine | undefined
): engine is "mongo" | "cassandra" | "redis" {
  return isNonSqlPatchEngineFromRegistry(engine);
}
