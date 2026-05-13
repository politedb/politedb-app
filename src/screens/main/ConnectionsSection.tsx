import type { ConnectionProfile } from "src/lib/tauri";
import { Button } from "src/components/common/Button";
import type { ViewMode } from "src/types";
import { ConnectionCard } from "./ConnectionCard";
import type { ConnectionGroup } from "src/stores/connectionGroups";

function EmptyState(props: {
  hasSearch: boolean;
  profilesEmpty: boolean;
  onCreate: () => void;
  onUseTemplate?: () => void | Promise<void>;
  templateSaving?: boolean;
}) {
  const { hasSearch, profilesEmpty, onUseTemplate, templateSaving } = props;

  return (
    <div class="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
      <div class="font-semibold text-slate-900">
        {hasSearch ? "No matching connections" : "No connections yet"}
      </div>
      <div class="mt-1 text-sm text-slate-500">
        {hasSearch
          ? "Try a different keyword."
          : "Create a connection to start querying databases."}
      </div>

      {!hasSearch ? (
        <div class="mt-5 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-center">
          {profilesEmpty && onUseTemplate ? (
            <Button
              type="button"
              variant="default"
              class="border py-2 text-sm"
              loading={templateSaving}
              disabled={templateSaving}
              onClick={() => void onUseTemplate()}
            >
              Start with a SQLite template
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ConnectionsSection(props: {
  profiles: ConnectionProfile[];
  selectedId?: string;
  viewMode: ViewMode;
  searchQuery: string;
  groups: ConnectionGroup[];
  groupIdsByProfile: Record<string, string[]>;
  templateSaving?: boolean;
  onCreate: () => void;
  onUseSqliteTemplate?: () => void | Promise<void>;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onAssignGroups: (id: string, groupIds: string[]) => void | Promise<void>;
  onDuplicate?: (id: string) => void | Promise<void>;
}) {
  const {
    profiles,
    selectedId,
    viewMode,
    searchQuery,
    groups,
    groupIdsByProfile,
    templateSaving,
    onCreate,
    onUseSqliteTemplate,
    onOpen,
    onEdit,
    onAssignGroups,
    onDuplicate,
  } = props;

  const hasSearch = !!searchQuery.trim();

  return (
    <div class="min-w-0">
      {/* Header row */}
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-semibold tracking-wide text-slate-800">
          Connections ({profiles.length})
        </h2>
      </div>

      {profiles.length === 0 ? (
        <EmptyState
          hasSearch={hasSearch}
          profilesEmpty={profiles.length === 0}
          onCreate={onCreate}
          onUseTemplate={onUseSqliteTemplate}
          templateSaving={templateSaving}
        />
      ) : viewMode === "grid" ? (
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {profiles.map((p) => (
            <div key={p.id} class="min-w-0">
              <ConnectionCard
                profileId={p.id}
                selected={selectedId === p.id}
                groups={groups}
                selectedGroupIds={groupIdsByProfile[p.id] ?? []}
                onAssignGroups={onAssignGroups}
                onOpen={() => onOpen(p.id)}
                onEdit={() => onEdit(p.id)}
                onDuplicate={onDuplicate ? () => onDuplicate(p.id) : undefined}
              />
            </div>
          ))}
        </div>
      ) : (
        <div class="space-y-2">
          {profiles.map((p) => (
            <ConnectionCard
              key={p.id}
              profileId={p.id}
              selected={selectedId === p.id}
              groups={groups}
              selectedGroupIds={groupIdsByProfile[p.id] ?? []}
              onAssignGroups={onAssignGroups}
              onOpen={() => onOpen(p.id)}
              onEdit={() => onEdit(p.id)}
              onDuplicate={onDuplicate ? () => onDuplicate(p.id) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
