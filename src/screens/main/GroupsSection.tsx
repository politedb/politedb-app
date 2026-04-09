import type { ConnectionGroup } from "src/stores/connectionGroups";
import { Button } from "src/components/common/Button";

export function GroupsSection(props: {
  groups: Array<{ group: ConnectionGroup; count: number }>;
  selectedGroupId?: string;
  onPickGroup: (groupId?: string) => void;
}) {
  const { groups, selectedGroupId, onPickGroup } = props;
  if (!groups.length) return null;

  return (
    <div class="mb-5">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-sm font-semibold tracking-wide text-slate-800">
          Groups
        </h2>
        <div class="text-xs text-slate-400">{groups.length}</div>
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
        {groups.map(({ group, count }) => (
          <Button
            key={group.id}
            variant="outline"
            onClick={() => onPickGroup(group.id)}
            class={`rounded-full px-2 text-xs font-semibold ${
              selectedGroupId === group.id
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <span class="max-w-55 truncate">{group.name}</span>
            <span class="ml-1 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600">
              {count}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
