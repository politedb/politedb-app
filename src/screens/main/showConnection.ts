/**
 * The group filter to keep when showing one connection on the Connections
 * page: the current one if the connection is in it, else none (All), so the
 * connection is never hidden by the filter.
 */
export function groupFilterShowing(
  profileId: string,
  selectedGroupId: string | undefined,
  groupIdsByProfile: Readonly<Record<string, readonly string[]>>
): string | undefined {
  if (!selectedGroupId) return undefined;
  return (groupIdsByProfile[profileId] ?? []).includes(selectedGroupId)
    ? selectedGroupId
    : undefined;
}
