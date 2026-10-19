import { useEffect, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  aiAgentDataAccessList,
  aiAgentDataAccessRevoke,
  type AiDataAccessGrant,
} from "src/lib/tauri/aiAgent";
import { useScreenStore } from "src/stores/screen";
import {
  aiChatScopesOwnedBy,
  purgeAiChatScopes,
} from "./hooks/useAiChatSession";

/**
 * Connections the AI agent may read data from (plan ai-agent R5). Revoking removes
 * the permission, stops agent runs on that connection and deletes its chat history.
 */
export function AiDataAccessList() {
  const [grants, setGrants] = useState<AiDataAccessGrant[] | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    aiAgentDataAccessList()
      .then(setGrants)
      .catch(() => setGrants([]));

  useEffect(() => {
    void load();
  }, []);

  const revoke = async (profileId: string) => {
    setError("");
    try {
      await aiAgentDataAccessRevoke(profileId);
      const open = useScreenStore
        .getState()
        .profileTabs.filter((tab) => tab.profileId === profileId)
        .map((tab) => tab.id);
      // Closed tabs keep their chats too: purge every scope this connection owned.
      purgeAiChatScopes([
        ...new Set([...open, ...aiChatScopesOwnedBy(profileId)]),
      ]);
      await load();
    } catch {
      setError("Could not revoke data access. Try again.");
    }
  };

  return (
    <div class="ml-5 space-y-1">
      <div class="font-medium text-neutral-800">Data access</div>
      <p class="text-neutral-500">
        Read-only queries, only on connections you allowed. In safe and
        production mode each query asks for Touch ID or your password; lock mode
        turns them off.
      </p>
      {grants?.length ? (
        <ul class="space-y-1">
          {grants.map((grant) => (
            <li
              key={`${grant.profileId}-${grant.providerLabel}`}
              class="flex items-center justify-between gap-2"
            >
              <span class="min-w-0 truncate">
                {grant.profileLabel ?? "Deleted connection"} →{" "}
                {grant.providerLabel ?? grant.endpointHost}
              </span>
              <Button
                variant="ghost"
                class="shrink-0 px-2 py-0.5 text-xs"
                onClick={() => void revoke(grant.profileId)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : grants ? (
        <p class="text-neutral-400">No connection allowed yet.</p>
      ) : null}
      {error ? <p class="text-red-600">{error}</p> : null}
    </div>
  );
}
