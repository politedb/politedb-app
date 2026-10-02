import type { DatabaseEngine } from "src/types";
import { supportsTableMeta } from "src/lib/engines";

/** Engines that can load column metadata for the SQL table exporter. */
export function canStandaloneExportTable(engine?: DatabaseEngine): boolean {
  return supportsTableMeta(engine);
}

/** Short reason when standalone export must be hidden/disabled. */
export function standaloneExportUnavailableReason(
  engine?: DatabaseEngine
): string | null {
  if (canStandaloneExportTable(engine)) return null;
  if (engine === "redis") return "not available for Redis";
  if (engine === "mongo") return "not available for MongoDB";
  if (engine === "cassandra") return "not available for Cassandra";
  return "not available for this engine";
}
