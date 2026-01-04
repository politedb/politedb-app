import type { ConnectionProfile } from "src/lib/tauri";
import { Button } from "src/components/common/Button";
import { Grid } from "src/components/icons";
import type { ViewMode } from "src/types";

export function GroupsSection(props: {
  groups: Array<{ tag: string; connections: ConnectionProfile[] }>;
  viewMode: ViewMode;
  onPickTag: (tag: string) => void;
}) {
  const { groups, viewMode, onPickTag } = props;
  if (!groups.length) return null;

  return (
    <div class="mb-6">
      <h2 class="text-sm font-semibold text-slate-800 tracking-wide mb-3">
        Groups
      </h2>

      <div
        class={
          viewMode === "grid"
            ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"
            : "space-y-2"
        }
      >
        {groups.map((group) => (
          <Button
            key={group.tag}
            variant="ghost"
            onClick={() => onPickTag(group.tag)}
            class="w-full p-3 rounded-xl justify-start text-left bg-white shadow-sm hover:bg-neutral-50"
          >
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                <Grid className="size-5 text-blue-500" />
              </div>
              <div class="flex-1 flex flex-col min-w-0">
                <div class="font-semibold text-slate-900 truncate">
                  {group.tag}
                </div>
                <div class="text-xs text-slate-500">
                  {group.connections.length} Connection
                  {group.connections.length !== 1 ? "s" : ""}
                </div>
              </div>
            </div>
          </Button>
        ))}
      </div>
    </div>
  );
}
