import type { ConnectionProfile } from "src/lib/tauri";
import { Button } from "src/components/common/Button";
import type { ViewMode } from "src/types";
import { ConnectionCard } from "./ConnectionCard";

function EmptyState(props: { hasSearch: boolean; onCreate: () => void }) {
  const { hasSearch, onCreate } = props;

  return (
    <div class="text-center py-12">
      <p class="text-sm text-slate-500 mb-2">
        {hasSearch ? "No connections found" : "No connections yet"}
      </p>
      {!hasSearch ? (
        <Button
          variant="ghost"
          onClick={onCreate}
          class="text-blue-600 mx-auto hover:text-blue-700 hover:bg-transparent text-sm font-medium"
        >
          Create your first connection
        </Button>
      ) : null}
    </div>
  );
}

export function ConnectionsSection(props: {
  connections: ConnectionProfile[];
  selectedId: string | null;
  viewMode: ViewMode;
  searchQuery: string;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const {
    connections,
    selectedId,
    viewMode,
    searchQuery,
    onCreate,
    onOpen,
    onEdit,
  } = props;

  return (
    <div>
      <h2 class="text-sm font-semibold text-slate-800 tracking-wide mb-3">
        Connections
      </h2>

      {connections.length === 0 ? (
        <EmptyState hasSearch={!!searchQuery.trim()} onCreate={onCreate} />
      ) : (
        <div
          class={
            viewMode === "grid"
              ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4"
              : "space-y-2"
          }
        >
          {connections.map((conn) => (
            <ConnectionCard
              key={conn.id}
              conn={conn}
              selected={selectedId === conn.id}
              onOpen={() => onOpen(conn.id)}
              onEdit={() => onEdit(conn.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
