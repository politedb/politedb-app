import { memo, useEffect, useRef, useState } from "preact/compat";
import { profileExportOneEncrypted } from "src/lib/tauri";

import { DbIcon } from "src/components/icons/DbIcon";
import {
  EditIcon,
  SshIcon,
  TrashIcon,
  BackupIcon,
  FolderIcon,
  CopyIcon,
  PinIcon,
  PinFilledIcon,
  ArrowRightIcon,
} from "src/components/icons";
import { normalizeEngineName } from "src/utils/convert";
import { TagChips } from "src/components/common/TagChips";
import { ContextMenu } from "src/components/common/ContextMenu";
import { useProfileStore } from "src/stores/profile";
import { type ConnectionGroup } from "src/stores/connectionGroups";
import { usePinnedConnectionsStore } from "src/stores/pinnedConnections";
import { cn } from "src/utils/cn";
import { connectionProfileSummary } from "src/lib/connection/profileSummary";
import { confirmDialog, saveDialog, showMessage } from "src/lib/system-dialog";
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
} from "src/lib/profiles/profileSharing";
import { KebabButton } from "src/components/common/KebabButton";
import { isProductionTag } from "src/lib/queries/querySafety";

/* -------------------------------------------------- */
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
  const { engine, subtitle, hasSsh } = connectionProfileSummary(profile);

  const tags = profile.input?.tags;
  const chipTags = tags?.length
    ? tags
    : currentGroups.map((group) => group.name);
  const productionTag = tags?.find(isProductionTag);
  const otherTags = chipTags.filter((tag) => tag !== productionTag);

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
    closeMenu();
    const ok = await confirmDialog(
      `Delete "${profile.label || "Unnamed"}"? This removes the saved connection and cannot be undone.`,
      {
        title: "Delete connection",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      }
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
      aria-label={[label, normalizeEngineName(engine), subtitle]
        .filter(Boolean)
        .join(", ")}
      onClick={onSelectProfile}
      onDblClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onContextMenu={(e) => openMenuAtPoint(e)}
      onKeyDown={(e) => {
        // Keys on the card's own buttons (Open, ⋮) are theirs.
        if (e.target !== e.currentTarget) return;
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
                "size-2.5 shrink-0 rounded-full",
                hasCustomIndicator ? "" : "opacity-60"
              )}
              style={{ backgroundColor: indicatorColor }}
              title={hasCustomIndicator ? "Indicator color" : "Default color"}
            />

            {/* The name keeps its room; other tags only get what is left. A
                chip that does not fit wraps onto a hidden second line, so it
                disappears whole instead of being cut (the rest are in the
                "+N" tooltip). A production tag is a warning, so it always
                stays visible next to the name. */}
            <span
              class="min-w-0 truncate text-sm font-semibold text-slate-900 dark:text-slate-100"
              title={label}
            >
              {label}
            </span>

            {productionTag ? (
              <TagChips
                className="shrink-0"
                tags={[productionTag]}
                max={1}
                size="sm"
              />
            ) : null}

            <div class="min-w-0 flex-1 overflow-hidden">
              <TagChips
                className="h-5 flex-wrap before:-mr-1 before:h-5 before:w-0 before:content-[''] [&>*]:shrink-0"
                tags={otherTags}
                max={1}
                size="sm"
              />
            </div>
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

      {/* RIGHT: open (a double-click or Enter does the same) and the menu,
          shown on hover or keyboard focus. */}
      <div class="relative z-10 flex shrink-0 items-center gap-1">
        <button
          type="button"
          title="Open in a new tab"
          aria-label={`Open ${label}`}
          class={cn(
            "flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition",
            "border-blue-200 bg-white text-blue-700 hover:bg-blue-50",
            "dark:border-blue-500/40 dark:bg-transparent dark:text-blue-300 dark:hover:bg-blue-950/40",
            "focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none",
            "hidden group-focus-within:flex group-hover:flex"
          )}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          onDblClick={(e) => e.stopPropagation()}
        >
          Open
          <ArrowRightIcon className="size-3" aria-hidden="true" />
        </button>
        <KebabButton
          menuOpen={menuOpen}
          onClick={() => openMenuAtAnchor()}
          buttonRef={kebabRef}
          label={label}
        />
      </div>

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
        autoFocus
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
