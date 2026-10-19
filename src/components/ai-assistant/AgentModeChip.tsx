import { ProBadge } from "src/components/license/ProBadge";
import { useProGate } from "src/hooks/useProGate";

/** Shows that agent mode is a Pro feature, for every tier; Free users can upgrade from it. */
export function AgentModeChip() {
  const { hasPro, requirePro } = useProGate();
  return (
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
      title={
        hasPro
          ? "Agent mode is included with Pro"
          : "Agent mode is a Pro feature"
      }
      onClick={() => {
        if (!hasPro) requirePro("ai-agent");
      }}
    >
      Agent
      <ProBadge />
    </button>
  );
}
