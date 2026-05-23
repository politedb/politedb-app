import type { ConnectionGroup } from "src/stores/connectionGroups";
import { Button } from "src/components/common/Button";
import { XIcon } from "src/components/icons/X";

export function GroupsSection(props: {
  groups: Array<{ group: ConnectionGroup; count: number }>;
  selectedGroupId?: string;
  onPickGroup: (groupId?: string) => void;
  onDeleteGroup: (groupId: string) => void | Promise<void>;
}) {
  const { groups, selectedGroupId, onPickGroup, onDeleteGroup } = props;

  if (!groups.length) return null;

  async function onDelete(group: ConnectionGroup) {
    const ok = await Promise.resolve(
      window.confirm(
        `Delete connection?\n\nConnections in "${group.name}" will become ungrouped.`
      )
    );
    if (!ok) return;
    await onDeleteGroup(group.id);
  }

  return (
    <div class="mb-5">
      <div class="mb-3 flex items-center">
        <h3 class="text-xs font-semibold tracking-wide text-slate-800 uppercase">
          Groups ({groups.length})
        </h3>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => onPickGroup(undefined)}
          class={`rounded-full px-3 text-xs font-semibold ${
            !selectedGroupId
              ? "border-blue-300 bg-blue-50 text-blue-700"
              : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          All
        </Button>
        {groups.map(({ group }) => (
          <div
            key={group.id}
            class={`flex items-center gap-1 rounded-full border py-1 pr-2 pl-3 text-xs font-semibold ${
              selectedGroupId === group.id
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <button
              type="button"
              onClick={() => onPickGroup(group.id)}
              class="flex min-w-0 items-center gap-1"
            >
              <span class="max-w-55 truncate">{group.name}</span>
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(group);
              }}
              class="rounded-full p-0.5 text-slate-400 transition-all hover:bg-red-50 hover:text-red-600"
              aria-label={`Delete group ${group.name}`}
              title="Delete group"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
