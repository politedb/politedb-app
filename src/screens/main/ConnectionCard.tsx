import { memo } from "preact/compat";
import type { ConnectionProfile } from "src/lib/tauri";
import { ConfirmPopover } from "src/components/modal/ConfirmPopover";
import { DbIcon } from "src/components/icons/DbIcon";
import { Edit, Trash } from "src/components/icons";
import { TagChips } from "src/components/common/TagChips";
import { useProfileStore } from "src/stores/profile";

function firstNonEmpty(...xs: Array<string | undefined | null>) {
  for (const x of xs) {
    const v = (x ?? "").trim();
    if (v) return v;
  }
  return "";
}

type EngineInput =
  | ConnectionProfile["input"]["postgres"]
  | ConnectionProfile["input"]["mysql"]
  | ConnectionProfile["input"]["redis"];

function getEngineInput(profile: ConnectionProfile): {
  engine: string;
  input: EngineInput | undefined;
} {
  const engine = String(profile.engine || profile.input?.engine || "");
  if (engine === "postgres") return { engine, input: profile.input?.postgres };
  if (engine === "mysql") return { engine, input: profile.input?.mysql };
  if (engine === "redis") return { engine, input: profile.input?.redis };
  return { engine, input: undefined };
}

function buildSubtitle(profile: ConnectionProfile) {
  const { engine, input } = getEngineInput(profile);

  const host = (input as any)?.host as string | undefined;
  const port = (input as any)?.port as number | undefined;

  const database =
    engine === "postgres"
      ? (profile.input?.postgres?.database ?? "")
      : engine === "mysql"
        ? (profile.input?.mysql?.database ?? "")
        : engine === "redis"
          ? profile.input?.redis?.db != null
            ? `db ${profile.input.redis.db}`
            : ""
          : "";

  const hostPort = host ? `${host}${port != null ? `:${port}` : ""}` : "";
  const subtitle = firstNonEmpty(
    hostPort && database ? `${hostPort} • ${database}` : hostPort,
    database
  );

  return { engine, subtitle, hasSsh: !!profile.input?.ssh };
}

function ConnectionStatusDot({ online }: { online: boolean }) {
  return (
    <span
      class={`relative inline-flex h-3 w-3 rounded-full border border-white ${
        online ? "bg-emerald-500" : "bg-slate-300"
      }`}
      title={online ? "Connected" : "Not connected"}
      aria-label={online ? "Connected" : "Not connected"}
    >
      {online ? (
        <span class="pointer-events-none absolute inset-0 animate-ping rounded-full bg-emerald-500/40" />
      ) : null}
    </span>
  );
}

export const ConnectionCard = memo(function ConnectionCard(props: {
  profileId: string;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const { profileId, selected, onOpen, onEdit } = props;

  const profile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === profileId)
  );
  const removeProfile = useProfileStore((s) => s.removeProfile);

  if (!profile) return null;

  const label = profile.label || "Unnamed";
  const { engine, subtitle, hasSsh } = buildSubtitle(profile);

  const tags = profile.input?.tags;

  // only tint when user actually picked a color
  const indicator_color = String(profile.input.indicator_color ?? "").trim();

  const hasTint = indicator_color.length > 0;

  const connected = !!(profile as any).connected;

  async function onDeleteProfile() {
    if (!profile) return;
    await removeProfile(profile.id);
  }

  // Make gradient longer + softer
  const tintBg = hasTint
    ? `linear-gradient(90deg,
      ${indicator_color} 0%,
      ${indicator_color} 38%,
      ${indicator_color} 48%,
      rgba(255,255,255,0) 82%)`
    : undefined;

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
      class={`group relative flex cursor-pointer items-center justify-between gap-3 rounded-2xl border px-3.5 py-3 shadow-sm transition-all ${
        selected
          ? "border-blue-600 bg-blue-50"
          : "border-slate-200 bg-white hover:bg-neutral-50"
      }`}
    >
      {/* Animated tint (only if indicator_color exists) */}
      {hasTint ? (
        <div
          class={`pointer-events-none absolute inset-0 -translate-x-2.5 rounded-2xl opacity-0 transition-[opacity,transform] duration-200 ease-out ${selected ? "translate-x-0 opacity-[0.09]" : "group-hover:translate-x-0 group-hover:opacity-[0.07]"}`}
          style={{ background: tintBg }}
          aria-hidden="true"
        />
      ) : null}

      {/* LEFT */}
      <div class="relative z-10 flex min-w-0 flex-1 items-center gap-3 pl-1">
        {/* Avatar + status dot */}
        <div class="relative shrink-0">
          <div class="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200">
            <DbIcon engine={engine} px={28} className="h-7 w-7" />
          </div>

          <div class="absolute -right-1.5 -bottom-2 rounded-full bg-white p-px">
            <ConnectionStatusDot online={connected} />
          </div>
        </div>

        {/* Text */}
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm font-semibold text-slate-900">
              {label}
            </span>

            {tags?.length ? (
              <TagChips
                tags={tags}
                max={2}
                size="sm"
                className="min-w-0 flex-nowrap overflow-hidden"
              />
            ) : null}
          </div>

          <div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500">
            {subtitle ? (
              <span class="min-w-0 truncate" title={subtitle}>
                {subtitle}
              </span>
            ) : (
              <span class="text-slate-400">—</span>
            )}

            {hasSsh ? (
              <span class="shrink-0 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                SSH
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* RIGHT */}
      <div class="relative z-10 flex shrink-0 items-center gap-1">
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
              title="Delete"
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
          class="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="Edit connection"
          title="Edit"
        >
          <Edit className="size-5" />
        </button>
      </div>
    </div>
  );
});
