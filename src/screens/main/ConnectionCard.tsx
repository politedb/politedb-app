import { memo, RefObject, useEffect, useRef, useState } from "preact/compat";
import {
  profileExportOneEncrypted,
  type ConnectionProfile,
} from "src/lib/tauri";

import { DbIcon } from "src/components/icons/DbIcon";
import {
  EditIcon,
  SshIcon,
  TrashIcon,
  MoreVerticalIcon,
  BackupIcon,
  FolderIcon,
  CopyIcon,
  PinIcon,
  PinFilledIcon,
} from "src/components/icons";
import { TagChips } from "src/components/common/TagChips";
import { ContextMenu } from "src/components/common/ContextMenu";
import { useProfileStore } from "src/stores/profile";
import { type ConnectionGroup } from "src/stores/connectionGroups";
import { usePinnedConnectionsStore } from "src/stores/pinnedConnections";
import { cn } from "src/utils/cn";
import { formatConnectionDatabaseDisplay } from "src/utils/connection";
import { saveDialog, showMessage } from "src/lib/system-dialog";
import { writeTextFile } from "src/lib/system-fs";
import { AssignConnectionGroupDialog } from "src/components/modal/AssignConnectionGroupDialog";
import {
  ExportConnectionDialog,
  type ExportConnectionOptions,
} from "src/components/modal/ExportConnectionDialog";
import {
  formatExportPasswordError,
  CONNECTION_EXPORT_EXTENSION,
  formatSharingExportSuccessMessage,
} from "src/utils/profileSharing";

/* -------------------------------------------------- */
/* utils */

function firstNonEmpty(...xs: Array<string | undefined | null>) {
  for (const x of xs) {
    const v = (x ?? "").trim();
    if (v) return v;
  }
  return "";
}

function formatConnectionTarget(
  profile: ConnectionProfile,
  engine: string,
  host?: string,
  port?: number
) {
  switch (engine) {
    case "d1":
      return profile.input?.d1?.account_id?.trim() ?? "";
    case "turso":
      return profile.input?.turso?.url?.trim() ?? "";
    case "snowflake":
      return profile.input?.snowflake?.account?.trim() ?? "";
    case "google_sheets":
      return "";
    default:
      return host ? `${host}${port != null ? `:${port}` : ""}` : "";
  }
}

export function getConnectionCardToneClass(
  selected: boolean,
  isPinned: boolean
) {
  if (selected) {
    return "border-blue-600 bg-blue-50 dark:border-blue-500/80 dark:bg-blue-950/35";
  }
  if (isPinned) {
    return "border-amber-200 bg-amber-50/40 hover:bg-amber-50/70 dark:border-amber-500/40 dark:bg-amber-950/40 dark:hover:bg-amber-950/60";
  }
  return "border-slate-200 bg-white hover:bg-neutral-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800";
}

type EngineInput =
  | ConnectionProfile["input"]["postgres"]
  | ConnectionProfile["input"]["mysql"]
  | ConnectionProfile["input"]["sqlserver"]
  | ConnectionProfile["input"]["sqlite"]
  | ConnectionProfile["input"]["d1"]
  | ConnectionProfile["input"]["turso"]
  | ConnectionProfile["input"]["oracle"]
  | ConnectionProfile["input"]["mongo"]
  | ConnectionProfile["input"]["cassandra"]
  | ConnectionProfile["input"]["redis"]
  | ConnectionProfile["input"]["snowflake"]
  | ConnectionProfile["input"]["duckdb"]
  | ConnectionProfile["input"]["clickhouse"]
  | ConnectionProfile["input"]["google_sheets"];

function getEngineInput(profile: ConnectionProfile): {
  engine: string;
  input: EngineInput | undefined;
} {
  const engine = String(profile.engine || profile.input?.engine || "");
  if (engine === "postgres") {
    return { engine, input: profile.input?.postgres };
  }
  if (engine === "mysql" || engine === "mariadb") {
    return { engine, input: profile.input?.mysql };
  }
  if (engine === "sqlserver") {
    return { engine, input: profile.input?.sqlserver };
  }
  if (engine === "mongo") {
    return { engine, input: profile.input?.mongo };
  }
  if (engine === "cassandra") {
    return { engine, input: profile.input?.cassandra };
  }
  if (engine === "sqlite") {
    return { engine, input: profile.input?.sqlite };
  }
  if (engine === "d1") {
    return { engine, input: profile.input?.d1 };
  }
  if (engine === "turso") {
    return { engine, input: profile.input?.turso };
  }
  if (engine === "oracle") {
    return { engine, input: profile.input?.oracle };
  }
  if (engine === "snowflake") {
    return { engine, input: profile.input?.snowflake };
  }
  if (engine === "duckdb") {
    return { engine, input: profile.input?.duckdb };
  }
  if (engine === "redis") {
    return { engine, input: profile.input?.redis };
  }
  if (engine === "clickhouse") {
    return { engine, input: profile.input?.clickhouse };
  }
  if (engine === "google_sheets") {
    return { engine, input: profile.input?.google_sheets };
  }
  return { engine, input: undefined };
}

function buildSubtitle(profile: ConnectionProfile) {
  const { engine, input } = getEngineInput(profile);

  const host =
    input && "host" in input ? (input.host as string | undefined) : undefined;
  const port =
    input && "port" in input ? (input.port as number | undefined) : undefined;

  let database = "";
  switch (engine) {
    case "postgres":
      database = profile.input?.postgres?.database ?? "";
      break;
    case "mysql":
    case "mariadb":
      database = profile.input?.mysql?.database ?? "";
      break;
    case "sqlserver":
      database = profile.input?.sqlserver?.database ?? "";
      break;
    case "sqlite":
      database = profile.input?.sqlite?.path ?? "";
      break;
    case "d1":
      database = profile.input?.d1?.database_id ?? "";
      break;
    case "turso":
      database = "";
      break;
    case "oracle":
      database = profile.input?.oracle?.database ?? "";
      break;
    case "snowflake":
      database = profile.input?.snowflake?.database ?? "";
      break;
    case "duckdb":
      database = profile.input?.duckdb?.path ?? "";
      break;
    case "mongo":
      database = profile.input?.mongo?.database ?? "";
      break;
    case "cassandra":
      database = profile.input?.cassandra?.keyspace ?? "";
      break;
    case "redis":
      database =
        profile.input?.redis?.db != null ? `db ${profile.input.redis.db}` : "";
      break;
    case "clickhouse":
      database = profile.input?.clickhouse?.database ?? "";
      break;
    case "google_sheets":
      database = profile.input?.google_sheets?.spreadsheet_id ?? "";
      break;
  }

  const hostPort = formatConnectionTarget(profile, engine, host, port);
  const databaseLabel = formatConnectionDatabaseDisplay(database, engine);
  const subtitle = firstNonEmpty(
    hostPort && databaseLabel ? `${hostPort} • ${databaseLabel}` : hostPort,
    databaseLabel
  );

  return { engine, subtitle, hasSsh: !!profile.input?.ssh };
}

/* -------------------------------------------------- */
/* Kebab button */

const KebabButton = memo(function KebabButton(props: {
  menuOpen: boolean;
  onClick: (e: MouseEvent) => void;
  buttonRef: RefObject<HTMLButtonElement>;
}) {
  const { menuOpen, onClick, buttonRef } = props;

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      }}
      aria-label="Open menu"
      class={[
        "rounded-full p-2 text-slate-400 transition",
        "hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200",
        menuOpen
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 focus:opacity-100",
      ].join(" ")}
    >
      <MoreVerticalIcon className="size-5" />
    </button>
  );
});

/* -------------------------------------------------- */
/* Connection card */
const DEFAULT_INDICATOR_COLOR = "#94A3B8"; // slate-300

export const ConnectionCard = memo(function ConnectionCard(props: {
  profileId: string;
  selected: boolean;
  groups: ConnectionGroup[];
  selectedGroupIds: string[];
  onAssignGroups: (
    profileId: string,
    groupIds: string[]
  ) => void | Promise<void>;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate?: () => void | Promise<void>;
  onSelectProfile: () => void;
}) {
  const {
    profileId,
    selected,
    groups,
    selectedGroupIds,
    onAssignGroups,
    onOpen,
    onEdit,
    onDuplicate,
    onSelectProfile,
  } = props;

  const profile = useProfileStore((s) =>
    s.profiles.find((p) => p.id === profileId)
  );
  const removeProfile = useProfileStore((s) => s.removeProfile);
  const ensurePinnedLoaded = usePinnedConnectionsStore((s) => s.ensureLoaded);
  const isPinned = usePinnedConnectionsStore((s) => s.isPinned(profileId));
  const togglePin = usePinnedConnectionsStore((s) => s.togglePin);
  const selectedGroupIdSet = new Set(selectedGroupIds);
  const currentGroups = groups.filter((group) =>
    selectedGroupIdSet.has(group.id)
  );

  const kebabRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [assignGroupOpen, setAssignGroupOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(
    null
  );

  if (!profile) return null;

  const label = profile.label || "Unnamed";
  const { engine, subtitle, hasSsh } = buildSubtitle(profile);

  const tags = profile.input?.tags;

  const rawIndicator = String(profile.input.indicator_color ?? "").trim();
  const hasCustomIndicator = rawIndicator.length > 0;
  const indicatorColor = hasCustomIndicator
    ? rawIndicator
    : DEFAULT_INDICATOR_COLOR;

  function openMenuAtAnchor() {
    setMenuPoint(null);
    setMenuOpen(true);
  }

  function openMenuAtPoint(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuPoint({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  }

  function closeMenu() {
    setMenuOpen(false);
    setMenuPoint(null);
  }

  async function onDelete() {
    if (!profile) return;
    const ok = await Promise.resolve(
      window.confirm(
        "Delete connection?\n\nThis will remove the saved connection."
      )
    );
    if (!ok) return;
    await removeProfile(profile.id);
  }

  function openExportDialog() {
    closeMenu();
    setExportDialogOpen(true);
  }

  async function runSharingExport(options: ExportConnectionOptions) {
    if (!profile) return;
    const currentProfile = profile;

    setExportBusy(true);
    try {
      const safeLabel = (currentProfile.label || "connection")
        .trim()
        .replace(/[\\/:*?"<>|]+/g, "-");
      const path = await saveDialog({
        title: "Export connection for sharing",
        defaultPath: `${safeLabel}.${CONNECTION_EXPORT_EXTENSION}`,
        filters: [
          {
            name: "PoliteDB Connection",
            extensions: [CONNECTION_EXPORT_EXTENSION],
          },
        ],
      });
      if (!path) return;

      const json = await profileExportOneEncrypted(
        currentProfile.id,
        options.filePassword,
        {
          includeDbPassword: options.includeDbPassword,
          includeSshPassword: options.includeSshPassword,
        }
      );
      await writeTextFile(path, json);

      setExportDialogOpen(false);
      await showMessage(
        formatSharingExportSuccessMessage({
          includeDbPassword: options.includeDbPassword,
          includeSshPassword: options.includeSshPassword,
        }),
        {
          title: "Export completed",
          kind: "info",
        }
      );
    } catch (err) {
      await showMessage(formatExportPasswordError(err), {
        title: "Export failed",
        kind: "error",
      });
    } finally {
      setExportBusy(false);
    }
  }

  useEffect(() => {
    ensurePinnedLoaded();
  }, [ensurePinnedLoaded]);

  useEffect(() => {
    if (!menuOpen) return;
    return () => closeMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const menuPosition = (() => {
    if (menuPoint) return { x: menuPoint.x + 6, y: menuPoint.y + 6 };
    const r = kebabRef.current?.getBoundingClientRect();
    if (r) return { x: r.right - 176, y: r.bottom + 6 };
    return { x: 0, y: 0 };
  })();

  return (
    <div
      data-density-card
      role="button"
      tabIndex={0}
      onClick={onSelectProfile}
      onDblClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onContextMenu={(e) => openMenuAtPoint(e)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
        if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
          e.preventDefault();
          openMenuAtAnchor();
        }
      }}
      class={cn(
        "group relative flex cursor-default items-center justify-between gap-3 select-none",
        "overflow-hidden rounded-2xl border px-3.5 py-3 shadow-sm transition",
        getConnectionCardToneClass(selected, isPinned)
      )}
    >
      {/* LEFT */}
      <div class="relative z-10 flex min-w-0 flex-1 items-center gap-3">
        <div
          data-density-card-icon
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700"
        >
          <DbIcon engine={engine} px={28} className="h-7 w-7" />
        </div>

        <div class="min-w-0 flex-1">
          {/* Title row */}
          <div class="flex min-w-0 items-center gap-2">
            {/* Indicator */}
            <span
              class={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full",
                hasCustomIndicator ? "" : "opacity-60"
              )}
              style={{ backgroundColor: indicatorColor }}
              title={hasCustomIndicator ? "Indicator color" : "Default color"}
            />

            <span class="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {label}
            </span>

            {tags?.length ? (
              <div class="min-w-0 shrink-0">
                <TagChips
                  className="min-w-0 flex-nowrap overflow-hidden whitespace-nowrap"
                  tags={tags}
                  max={2}
                  size="sm"
                />
              </div>
            ) : null}

            {currentGroups.slice(0, 1).map((group) => (
              <span
                key={group.id}
                class="inline-flex max-w-32 items-center truncate rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:border-blue-500/40 dark:bg-blue-950/50 dark:text-blue-200"
                title={group.name}
              >
                {group.name}
              </span>
            ))}
            {currentGroups.length > 1 ? (
              <span class="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                +{currentGroups.length - 1}
              </span>
            ) : null}
          </div>

          {/* Subtitle row */}
          <div
            data-density-card-subtitle
            class="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500 dark:text-slate-400"
          >
            {subtitle ? (
              <span class="min-w-0 truncate" title={subtitle}>
                {subtitle}
              </span>
            ) : (
              <span class="text-slate-400 dark:text-slate-500">—</span>
            )}

            {hasSsh ? (
              <>
                <span class="text-slate-300 dark:text-slate-600">•</span>
                <span
                  class="inline-flex items-center gap-1 font-mono text-xs font-semibold tracking-wide text-indigo-500"
                  title="Connected via SSH tunnel"
                >
                  <SshIcon className="h-3.5 w-3.5 text-slate-400" />
                  SSH
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* RIGHT */}
      <KebabButton
        menuOpen={menuOpen}
        onClick={() => openMenuAtAnchor()}
        buttonRef={kebabRef}
      />

      <ContextMenu
        open={menuOpen}
        x={menuPosition.x}
        y={menuPosition.y}
        items={[
          {
            type: "item",
            label: isPinned ? "Unpin from favorites" : "Pin to favorites",
            icon: isPinned ? (
              <PinFilledIcon className="size-4 text-amber-500" />
            ) : (
              <PinIcon className="size-4" />
            ),
            onClick: () => {
              closeMenu();
              ensurePinnedLoaded();
              togglePin(profileId);
            },
          },
          { type: "sep" },
          {
            type: "item",
            label: "Edit Connection",
            icon: <EditIcon className="size-4" />,
            onClick: () => {
              closeMenu();
              onEdit();
            },
          },
          ...(onDuplicate
            ? [
                {
                  type: "item" as const,
                  label: "Duplicate Connection",
                  icon: <CopyIcon className="size-4" />,
                  onClick: () => {
                    closeMenu();
                    void onDuplicate();
                  },
                },
              ]
            : []),
          {
            type: "item",
            label: "Export this connection",
            icon: <BackupIcon className="size-4" />,
            onClick: () => {
              openExportDialog();
            },
          },
          { type: "sep" },
          {
            type: "item",
            label: "Move to Group",
            icon: <FolderIcon className="size-4" />,
            onClick: () => {
              closeMenu();
              setAssignGroupOpen(true);
            },
          },
          { type: "sep" },
          {
            type: "item",
            label: "Delete",
            icon: <TrashIcon className="size-4" />,
            color: "red",
            onClick: () => {
              onDelete();
            },
          },
        ]}
        onClose={closeMenu}
      />

      <ExportConnectionDialog
        open={exportDialogOpen}
        connectionLabel={label}
        busy={exportBusy}
        onClose={() => {
          if (!exportBusy) setExportDialogOpen(false);
        }}
        onConfirm={(exportOptions) => void runSharingExport(exportOptions)}
      />

      {assignGroupOpen ? (
        <AssignConnectionGroupDialog
          open={assignGroupOpen}
          onClose={() => setAssignGroupOpen(false)}
          connectionLabel={label}
          groups={groups}
          selectedGroupIds={currentGroups.map((group) => group.id)}
          onSave={async (groupIds) => {
            await onAssignGroups(profile.id, groupIds);
            setAssignGroupOpen(false);
          }}
        />
      ) : null}
    </div>
  );
});
