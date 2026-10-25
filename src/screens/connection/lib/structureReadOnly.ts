import type { DatabaseEngine } from "src/types";
import { SUPPORTED_DATABASES } from "src/constant";

const NO_STRUCTURE_EDITING: DatabaseEngine[] = ["mongo", "cassandra", "redis"];

/**
 * Why a table's structure cannot be edited, or null when it can. The one
 * place that decides structure read-only, so the reason shown always
 * matches the controls being disabled.
 */
export function structureReadOnlyReason(
  engine: DatabaseEngine,
  isProfileLocked: boolean
): string | null {
  if (isProfileLocked) {
    return "This connection is locked, so the structure is read-only.";
  }
  if (NO_STRUCTURE_EDITING.includes(engine)) {
    const label =
      SUPPORTED_DATABASES.find((db) => db.engine === engine)?.label ?? engine;
    return `Editing the structure isn't supported for ${label}; it is shown read-only.`;
  }
  return null;
}
