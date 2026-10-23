/**
 * Unsaved row edits and row deletions are keyed by the row's position on the
 * page where they were made. The table window's patch entry also records, per
 * position, the row as it was loaded (`originalRows`, outside the patches so it
 * never mixes with column values), and saving identifies each row from that
 * record: a later page, sort, filter or reload never redirects the change to
 * another row. Discarding before such a change keeps the grid's markers on the
 * right rows. New rows and structure changes are not positional.
 */
type WindowPatches = Partial<
  Record<string, Partial<Record<string, Record<string, unknown>>>>
> | null;

/** Rows recorded for a window's row patches, by page-local row key. */
export type RecordedRows = Record<string, unknown[]>;

export function hasRowPositionPatches(patches: WindowPatches | undefined) {
  if (!patches) return false;
  return (["update", "delete"] as const).some(
    (action) => Object.keys(patches[action]?.data ?? {}).length > 0
  );
}

/** The patches without row edits and row deletions (other changes kept). */
export function withoutRowPositionPatches<T extends WindowPatches>(
  patches: T
): T {
  if (!patches) return patches;
  const next = { ...patches } as Record<string, Record<string, unknown>>;
  for (const action of ["update", "delete"]) {
    const byKey = next[action];
    if (!byKey || !("data" in byKey)) continue;
    const { data: _data, ...rest } = byKey;
    next[action] = rest;
  }
  return next as T;
}

/** Internal patch fields that are never column values. */
export function isPatchMetaKey(key: string) {
  return key === "__rowKey";
}

/** Column values set by a row patch (internal fields left out). */
export function patchFieldEntries(patch: unknown): [string, unknown][] {
  return Object.entries((patch ?? {}) as Record<string, unknown>).filter(
    ([key]) => !isPatchMetaKey(key)
  );
}

/** The row a row patch at `rowKey` was made against, if one was recorded. */
export function recordedRow(
  entry: { originalRows?: RecordedRows } | null | undefined,
  rowKey: string
): unknown[] | undefined {
  const row = entry?.originalRows?.[rowKey];
  return Array.isArray(row) ? row : undefined;
}
