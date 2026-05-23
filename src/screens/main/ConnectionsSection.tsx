import { useMemo } from "preact/hooks";
import type { ConnectionProfile } from "src/lib/tauri";
import { Button } from "src/components/common/Button";
import { PinFilledIcon } from "src/components/icons";
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

function ConnectionCards(props: {
  profiles: ConnectionProfile[];
  selectedId?: string;
  viewMode: ViewMode;
  groups: ConnectionGroup[];
  groupIdsByProfile: Record<string, string[]>;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onAssignGroups: (id: string, groupIds: string[]) => void | Promise<void>;
  onDuplicate?: (id: string) => void | Promise<void>;
  onSelectProfile: (id: string) => void;
}) {
  const {
    profiles,
    selectedId,
    viewMode,
    groups,
    groupIdsByProfile,
    onOpen,
    onEdit,
    onAssignGroups,
    onDuplicate,
    onSelectProfile,
  } = props;

  if (viewMode === "grid") {
    return (
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
              onSelectProfile={() => onSelectProfile(p.id)}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
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
          onSelectProfile={() => onSelectProfile(p.id)}
        />
      ))}
    </div>
  );
}

export function ConnectionsSection(props: {
  profiles: ConnectionProfile[];
  pinnedIds: string[];
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
  onSelectProfile: (id: string) => void;
}) {
  const {
    profiles,
    pinnedIds,
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
    onSelectProfile,
  } = props;

  const hasSearch = !!searchQuery.trim();

  const { favoriteProfiles, otherProfiles } = useMemo(() => {
    const pinnedSet = new Set(pinnedIds);
    const favorites: ConnectionProfile[] = [];
    const others: ConnectionProfile[] = [];

    for (const profile of profiles) {
      if (pinnedSet.has(profile.id)) favorites.push(profile);
      else others.push(profile);
    }

    return { favoriteProfiles: favorites, otherProfiles: others };
  }, [profiles, pinnedIds]);

  const cardProps = {
    selectedId,
    viewMode,
    groups,
    groupIdsByProfile,
    onOpen,
    onEdit,
    onAssignGroups,
    onDuplicate,
    onSelectProfile,
  };

  return (
    <div class="min-w-0">
      {/* Header row */}

      {profiles.length === 0 ? (
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-xs font-semibold tracking-wide text-slate-800 uppercase">
              All Connections ({profiles.length})
            </h3>
          </div>
          <EmptyState
            hasSearch={hasSearch}
            profilesEmpty={profiles.length === 0}
            onCreate={onCreate}
            onUseTemplate={onUseSqliteTemplate}
            templateSaving={templateSaving}
          />
        </div>
      ) : (
        <div class="space-y-5">
          {favoriteProfiles.length > 0 ? (
            <section class="space-y-3">
              <div class="flex items-center gap-2">
                <PinFilledIcon className="size-4.5 text-amber-500" />
                <h2 class="text-xs font-semibold tracking-wide text-slate-800 uppercase">
                  Favorites ({favoriteProfiles.length})
                </h2>
              </div>
              <ConnectionCards profiles={favoriteProfiles} {...cardProps} />
            </section>
          ) : null}

          {otherProfiles.length > 0 ? (
            <section class="space-y-3">
              <h2 class="text-xs font-semibold tracking-wide text-slate-800 uppercase">
                All connections ({otherProfiles.length})
              </h2>
              <ConnectionCards profiles={otherProfiles} {...cardProps} />
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
