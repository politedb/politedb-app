import { memo } from "preact/compat";
import { Database, Edit, Trash } from "src/components/icons";
import { pickHostDbUser } from "src/utils/connection";
import { ConfirmPopover } from "src/components/modal/ConfirmPopover";
import { useProfileStore } from "src/stores/profile";

export const ConnectionCard = memo(function ConnectionCard({
  profileId,
  selected,
  onOpen,
  onEdit,
}: {
  profileId: string;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const profile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === profileId)
  );
  const removeProfile = useProfileStore((s) => s.removeProfile);

  if (!profile) return null;

  const label = profile.label || "Unnamed";
  const engine = profile.engine;
  const { host } = pickHostDbUser(profile);

  const tag = (profile as any).tag || "local";
  const statusColor = (profile as any).statusColor;
  const connected = (profile as any).connected;

  const onDeleteProfile = async () => {
    await removeProfile(profile.id);
  };

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
      {/* LEFT */}
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <div class="flex shrink-0 items-center justify-center rounded-full bg-blue-500 p-2 text-white">
          <Database className="size-6" />
        </div>

        <div class="min-w-0 flex-1">
          <div class="mb-1 truncate text-xs font-semibold text-slate-900">
            {label} <span class="text-xs text-green-600">({tag})</span>
          </div>

          <div class="flex items-center gap-2">
            {statusColor && (
              <span
                class="h-3 w-3 shrink-0 rounded-full"
                style={{ background: statusColor }}
              />
            )}
            <div class="flex-1 truncate text-xs text-slate-400">
              {host || "—"} : {engine}
            </div>
            {connected && (
              <div class="h-2 w-2 shrink-0 rounded-full bg-green-500" />
            )}
          </div>
        </div>
      </div>

      {/* ACTIONS */}
      <div class="flex items-center gap-1">
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
              aria-label="Delete connection"
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
          class="rounded-full p-2 transition hover:bg-slate-100"
          aria-label="Edit connection"
        >
          <Edit className="size-5" />
        </button>
      </div>
    </div>
  );
});
