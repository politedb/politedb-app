import { memo } from "preact/compat";
import type { ConnectionProfile } from "src/lib/tauri";
import { Database, Edit, Trash } from "src/components/icons";
import { pickHostDbUser } from "src/utils/connection";
import { ConfirmPopover } from "src/components/modal/ConfirmPopover";

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

  const onDeleteProfile = () => {};

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
      class={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2 shadow-sm transition-all ${
        selected
          ? "border-blue-600 bg-blue-50"
          : "border-slate-200 bg-white hover:bg-neutral-50"
      }`}
    >
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <div class="flex shrink-0 items-center justify-center rounded-full bg-blue-500 p-2 text-white">
          <Database className="size-6" />
        </div>

        <div class="min-w-0 flex-1">
          <div class="mb-1 truncate text-xs font-semibold text-slate-900">
            {label} <span class="text-xs text-green-600">({tag})</span>
          </div>

          <div class="flex items-center gap-2">
            {statusColor ? (
              <span
                class="h-3 w-3 shrink-0 rounded-full"
                style={{ background: statusColor }}
              />
            ) : null}
            <div class="flex-1 truncate text-xs text-slate-400">
              {host || "—"} : {engine}
            </div>
            {connected ? (
              <div class="h-2 w-2 shrink-0 rounded-full bg-green-500" />
            ) : null}
          </div>
        </div>
      </div>

      <div className={"flex items-center justify-between"}>
        <ConfirmPopover
          variant="danger"
          title="Delete connection?"
          description="This will remove the saved connection."
          confirmText="Delete"
          onConfirm={onDeleteProfile}
        >
          {({ open }) => (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                open();
              }}
              class="rounded-full p-2 text-slate-400 transition hover:bg-red-100 hover:text-red-700 active:bg-red-200"
              title="Delete Connection"
              aria-label="Delete Connection"
            >
              <Trash className="size-5" />
            </button>
          )}
        </ConfirmPopover>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          class="cursor-pointer rounded-full p-2 transition-colors hover:bg-slate-100"
          title="Edit connection"
          aria-label="Edit connection"
        >
          <Edit className="size-5" />
        </button>
      </div>
    </div>
  );
});
