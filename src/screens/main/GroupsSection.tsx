// src/screens/main/GroupsSection.tsx
import type { ConnectionProfile } from "src/lib/tauri";
import { Button } from "src/components/common/Button";

export function GroupsSection(props: {
  groups: Array<{ tag: string; connections: ConnectionProfile[] }>;
  onPickTag: (tag: string) => void;
}) {
  const { groups, onPickTag } = props;
  if (!groups.length) return null;

  return (
    <div class="mb-5">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-xs font-semibold tracking-wide text-slate-600">
          Groups
        </h2>
        <div class="text-xs text-slate-400">{groups.length}</div>
      </div>

      <div class="flex flex-wrap gap-2">
        {groups.map((g) => (
          <Button
            key={g.tag}
            variant="outline"
            onClick={() => onPickTag(g.tag)}
            class="h-9 rounded-full bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <span class="max-w-55 truncate">{g.tag}</span>
            <span class="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              {g.connections.length}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
