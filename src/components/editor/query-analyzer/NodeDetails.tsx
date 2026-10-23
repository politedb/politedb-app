import { useState } from "preact/hooks";
import { nodeDetailGroups } from "src/lib/query-analyzer/details";
import type { PlanHeat, PlanNode } from "src/lib/query-analyzer/plan";
import { cn } from "src/utils/cn";

/** "Other fields" start collapsed when there are more than this many. */
const OTHER_OPEN_LIMIT = 6;

/** The selected node's fields in groups; uncommon fields can be expanded. */
export function NodeDetails(props: { node: PlanNode; heat: PlanHeat }) {
  const { node, heat } = props;
  const [showOther, setShowOther] = useState(false);
  const groups = nodeDetailGroups(node, heat.nodes[node.id]!, heat.kind, {
    shares: heat.nodes.length > 1,
  });

  return (
    <section
      aria-label="Selected node"
      class="min-w-0 space-y-4 text-sm [overflow-wrap:anywhere]"
    >
      <h3 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {node.label}
      </h3>
      {groups.map((group) => {
        const collapsible =
          group.id === "other" && group.fields.length > OTHER_OPEN_LIMIT;
        const open = !collapsible || showOther;
        return (
          <div key={group.id}>
            <div class="mb-1.5 flex items-center justify-between">
              <h4 class="text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
                {group.title}
              </h4>
              {collapsible ? (
                <button
                  type="button"
                  aria-expanded={showOther}
                  onClick={() => setShowOther((v) => !v)}
                  class="text-xs text-blue-600 hover:underline dark:text-blue-300"
                >
                  {showOther
                    ? "Hide"
                    : `Show ${group.fields.length} more fields`}
                </button>
              ) : null}
            </div>
            {open ? (
              <dl class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
                {group.fields.map((field) => (
                  <div key={field.label} class="contents">
                    <dt class="text-neutral-500 dark:text-neutral-400">
                      {field.label}
                    </dt>
                    <dd
                      class={cn(
                        "min-w-0 text-neutral-900 dark:text-neutral-100",
                        field.code && "font-mono text-xs leading-5"
                      )}
                    >
                      {field.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
