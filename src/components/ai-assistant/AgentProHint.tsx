import { ProBadge } from "src/components/license/ProBadge";
import { useProUpgradeStore } from "src/stores/proUpgrade";

/** Device-level dismissal of the agent upgrade hint; holds no license or chat data. */
export const AGENT_PRO_HINT_DISMISSED_KEY =
  "politedb.ai.agentProHint.dismissed";

export function isAgentProHintDismissed() {
  try {
    return localStorage.getItem(AGENT_PRO_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissAgentProHint() {
  try {
    localStorage.setItem(AGENT_PRO_HINT_DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable: the hint closes for this session only.
  }
}

/** One line under a basic-chat answer that agent mode would have handled with Pro. */
export function AgentProHint(props: { onClose: () => void }) {
  return (
    <div class="mx-3 mt-2 flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-1.5 text-xs text-blue-900">
      <ProBadge />
      <span class="min-w-0 flex-1">
        Agent mode (looks up your schema and runs read-only queries) is a Pro
        feature.
      </span>
      <button
        type="button"
        class="font-medium text-blue-700 hover:underline"
        onClick={() => useProUpgradeStore.getState().open("ai-agent")}
      >
        Upgrade
      </button>
      <button
        type="button"
        class="text-blue-400 hover:text-blue-700"
        aria-label="Dismiss"
        onClick={() => {
          dismissAgentProHint();
          props.onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}
