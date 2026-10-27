import type { ConnectionGroup } from "src/stores/connectionGroups";
import { Button } from "src/components/common/Button";
import { XIcon, FolderIcon } from "src/components/icons";
import { confirmDialog } from "src/lib/system-dialog";

export function GroupsSection(props: {
  groups: Array<{ group: ConnectionGroup; count: number }>;
  selectedGroupId?: string;
  onPickGroup: (groupId?: string) => void;
  onDeleteGroup: (groupId: string) => void | Promise<void>;
}) {
  const { groups, selectedGroupId, onPickGroup, onDeleteGroup } = props;

  if (!groups.length) return null;

  async function onDelete(group: ConnectionGroup) {
    const ok = await confirmDialog(
      `Delete the group "${group.name}"? Its connections are kept and become ungrouped.`,
      {
        title: "Delete group",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      }
    );
    if (!ok) return;
    await onDeleteGroup(group.id);
  }

  return (
    <div class="mb-5">
      <div class="mb-3 flex items-center">
        <h3 class="flex items-center gap-2 text-sm font-semibold tracking-wide text-slate-800">
          <FolderIcon className="size-4 text-slate-500" />
          Groups ({groups.length})
        </h3>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button
          variant="outline"
          aria-pressed={!selectedGroupId}
          onClick={() => onPickGroup(undefined)}
          class={`rounded-full border px-3 py-0.75 text-sm font-semibold ${
            !selectedGroupId
              ? "border-blue-300 bg-blue-50 text-blue-700"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          All
        </Button>
        {groups.map(({ group, count }) => (
          <div
            key={group.id}
            class={`flex items-center gap-1 rounded-full border py-0.75 pr-2 pl-3 text-sm font-semibold ${
              selectedGroupId === group.id
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <button
              type="button"
              aria-pressed={selectedGroupId === group.id}
              onClick={() => onPickGroup(group.id)}
              class="flex min-w-0 items-center gap-1.5"
            >
              <span class="max-w-55 truncate">{group.name}</span>
              <span
                class="text-xs font-medium text-slate-400 tabular-nums"
                aria-label={`${count} connection${count === 1 ? "" : "s"}`}
              >
                {count}
              </span>
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
