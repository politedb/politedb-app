import type { TableItem } from "src/types";

/**
 * Whether a sidebar table matches the search `query` (trimmed, lower case).
 * Only names match while the list shows one schema: every table there is in
 * it, so matching the schema name would match them all.
 */
export function matchesSidebarSearch(
  table: Pick<TableItem, "schema" | "name">,
  query: string,
  activeSchema: string | undefined
): boolean {
  if (!query) return true;
  if (table.name.toLowerCase().includes(query)) return true;
  return !activeSchema && table.schema.toLowerCase().includes(query);
}
