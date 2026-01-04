import { memo } from "preact/compat";
import type { ConnectionProfile } from "src/lib/tauri";
import { Database, Edit } from "src/components/icons";
import { pickHostDbUser } from "src/utils/connection";

export const ConnectionCard = memo(function ConnectionCard(props: {
  conn: ConnectionProfile;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const { conn, selected, onOpen, onEdit } = props;

  const label = conn.label || "Unnamed";
  const engine = conn.engine;
  const { host } = pickHostDbUser(conn);

  const tag = (conn as any).tag || "local";
  const statusColor = (conn as any).statusColor;
  const connected = (conn as any).connected;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      class={`border shadow-sm transition-all cursor-pointer flex items-center justify-between gap-3 px-3 py-2 rounded-xl ${
        selected
          ? "border-blue-600 bg-blue-50"
          : "border-slate-200 bg-white hover:bg-neutral-50"
      }`}
    >
      <div class="flex items-center gap-3 flex-1 min-w-0">
        <div class="p-2 rounded-full bg-blue-500 flex items-center justify-center text-white shrink-0">
          <Database className="size-6" />
        </div>

        <div class="flex-1 min-w-0">
          <div class="font-semibold text-xs text-slate-900 truncate mb-1">
            {label} <span class="text-xs text-green-600">({tag})</span>
          </div>

          <div class="flex items-center gap-2">
            {statusColor ? (
              <span
                class="w-3 h-3 rounded-full shrink-0"
                style={{ background: statusColor }}
              />
            ) : null}
            <div class="text-xs text-slate-400 truncate flex-1">
              {host || "—"} : {engine}
            </div>
            {connected ? (
              <div class="w-2 h-2 rounded-full bg-green-500 shrink-0" />
            ) : null}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        class="p-2 hover:bg-slate-100 rounded-full transition-colors cursor-pointer"
        title="Edit connection"
        aria-label="Edit connection"
      >
        <Edit className="size-5" />
      </button>
    </div>
  );
});
