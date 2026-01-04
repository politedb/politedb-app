import type { ConnectionProfile } from "src/lib/tauri";
import { Button } from "src/components/common/Button";
import type { ViewMode } from "src/types";
import { ConnectionCard } from "./ConnectionCard";

function EmptyState(props: { hasSearch: boolean; onCreate: () => void }) {
  const { hasSearch, onCreate } = props;

  return (
    <div class="py-12 text-center">
      <p class="mb-2 text-sm text-slate-500">
        {hasSearch ? "No connections found" : "No connections yet"}
      </p>
      {!hasSearch ? (
        <Button
          variant="ghost"
          onClick={onCreate}
          class="mx-auto text-sm font-medium text-blue-600 hover:bg-transparent hover:text-blue-700"
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
      <h2 class="mb-3 text-sm font-semibold tracking-wide text-slate-800">
        Connections
      </h2>

      {connections.length === 0 ? (
        <EmptyState hasSearch={!!searchQuery.trim()} onCreate={onCreate} />
      ) : (
        <div
          class={
            viewMode === "grid"
              ? "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
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
