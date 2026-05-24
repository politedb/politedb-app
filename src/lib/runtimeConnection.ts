import { profileConnect } from "src/lib/tauri/profile";

const connectInflightByProfileId = new Map<string, Promise<string>>();

type TableDataMapEntry = { connectionId?: string | null };

/** Tab-level runtime id, or any connection already opened for this tab's tables. */
export function resolveTabRuntimeConnectionId(args: {
  tabRuntimeConnectionId?: string;
  activeProfileScreen: string;
  tableDataMap: Record<string, TableDataMapEntry>;
}): string | undefined {
  const { tabRuntimeConnectionId, activeProfileScreen, tableDataMap } = args;
  if (tabRuntimeConnectionId) return tabRuntimeConnectionId;

  const prefix = `${activeProfileScreen}.`;
  for (const [key, entry] of Object.entries(tableDataMap)) {
    if (!key.startsWith(prefix)) continue;
    const id = entry?.connectionId;
    if (id) return id;
  }
  return undefined;
}

/** One in-flight `profile_connect` per profile; shared across hooks. */
export async function connectProfileOnce(profileId: string): Promise<string> {
  const existing = connectInflightByProfileId.get(profileId);
  if (existing) return existing;

  const promise = profileConnect(profileId)
    .then((res) => res.connection.id)
    .finally(() => {
      connectInflightByProfileId.delete(profileId);
    });

  connectInflightByProfileId.set(profileId, promise);
  return promise;
}
