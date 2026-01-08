import type { ConnectionProfile } from "src/lib/tauri";
import { Button } from "src/components/common/Button";
import type { ViewMode } from "src/types";
import { ConnectionCard } from "./ConnectionCard";

function EmptyState(props: { hasSearch: boolean; onCreate: () => void }) {
  const { hasSearch, onCreate } = props;

  return (
    <div class="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
      <div class="text-sm font-semibold text-slate-900">
        {hasSearch ? "No matching connections" : "No connections yet"}
      </div>
      <div class="mt-1 text-sm text-slate-500">
        {hasSearch
          ? "Try a different keyword."
          : "Create a connection to start querying databases."}
      </div>

      {!hasSearch ? (
        <div class="mt-5">
          <Button variant="default" onClick={onCreate}>
            + New Connection
          </Button>
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
  onCreate: () => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const {
    profiles,
    selectedId,
    viewMode,
    searchQuery,
    onCreate,
    onOpen,
    onEdit,
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
        <EmptyState hasSearch={hasSearch} onCreate={onCreate} />
      ) : viewMode === "grid" ? (
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-3">
          {profiles.map((p) => (
            <div key={p.id} class="min-w-0">
              <ConnectionCard
                profileId={p.id}
                selected={selectedId === p.id}
                onOpen={() => onOpen(p.id)}
                onEdit={() => onEdit(p.id)}
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
              onOpen={() => onOpen(p.id)}
              onEdit={() => onEdit(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
