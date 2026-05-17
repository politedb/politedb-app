import { profileConnect } from "src/lib/tauri/profile";

const connectInflightByProfileId = new Map<string, Promise<string>>();

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
