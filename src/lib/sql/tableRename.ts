/**
 * The name a table is renamed to from the name field, or null for no
 * rename: blank, exactly the current name (an undo), or the current name
 * with spaces around it. The current name is compared as it is: it may
 * itself have spaces. The one rule for the editor, the pending change,
 * the SQL and the table reopened after saving.
 */
export function tableRenameTarget(
  input: unknown,
  currentName: string
): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim();
  if (!name || input === currentName || name === currentName) return null;
  return name;
}
