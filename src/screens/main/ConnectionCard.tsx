import { memo, RefObject, useEffect, useRef, useState } from "preact/compat";
import type { ConnectionProfile } from "src/lib/tauri";

import { DbIcon } from "src/components/icons/DbIcon";
import { Edit, Ssh, Trash, MoreVertical } from "src/components/icons";
import { TagChips } from "src/components/common/TagChips";
import { ConfirmPopover } from "src/components/modal/ConfirmPopover";
import { useProfileStore } from "src/stores/profile";
import { cn } from "src/utils/cn";

/* -------------------------------------------------- */
/* utils */

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

  const host = input?.host as string | undefined;
  const port = input?.port as number | undefined;

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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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
        "hover:bg-slate-100 hover:text-slate-700",
        menuOpen
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 focus:opacity-100",
      ].join(" ")}
    >
      <MoreVertical className="size-5" />
    </button>
  );
});

/* -------------------------------------------------- */
/* Card menu */
const MENU_WIDTH = 176; // ~w-44

function CardMenu(props: {
  open: boolean;
  anchorEl: HTMLElement | null;
  point: { x: number; y: number } | null;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { open, anchorEl, point, onClose, onEdit, onDelete } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onMouseDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onClose, true);

    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  let top = 0;
  let left = 0;

  if (point) {
    top = point.y + 6;
    left = point.x + 6;
  } else if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    top = r.bottom + 6;
    left = r.right - MENU_WIDTH;
  }

  // Keep inside viewport (basic clamp)
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  left = clamp(left, 8, Math.max(8, vw - MENU_WIDTH - 8));
  top = clamp(top, 8, Math.max(8, vh - 120)); // menu height-ish

  return (
    <div
      ref={ref}
      style={{ top, left }}
      class="fixed z-50 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
      role="menu"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 active:bg-slate-200"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          onEdit();
        }}
      >
        <Edit className="size-4 text-slate-500" />
        <span>Edit</span>
      </button>
      <ConfirmPopover
        variant="danger"
        title="Delete connection?"
        description="This will remove the saved connection."
        confirmText="Delete"
        onConfirm={() => {
          onClose();
          onDelete();
        }}
      >
        {({ open, triggerRef }) => (
          <button
            ref={triggerRef}
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 transition hover:bg-red-50 hover:text-red-700 active:bg-red-100"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              open();
            }}
          >
            <Trash className="size-4 text-red-500" />
            <span class="font-medium">Delete</span>
          </button>
        )}
      </ConfirmPopover>{" "}
    </div>
  );
}

/* -------------------------------------------------- */
/* Connection card */
const DEFAULT_INDICATOR_COLOR = "#94A3B8"; // slate-300

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

  const kebabRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
    await removeProfile(profile.id);
  }

  useEffect(() => {
    if (!menuOpen) return;
    return () => closeMenu();
  }, [profileId]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
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
        "group relative flex cursor-default items-center justify-between gap-3",
        "overflow-hidden rounded-2xl border px-3.5 py-3 shadow-sm transition",
        selected
          ? "border-blue-600 bg-blue-50"
          : "border-slate-200 bg-white hover:bg-neutral-50"
      )}
    >
      {/* LEFT */}
      <div class="relative z-10 flex min-w-0 flex-1 items-center gap-3">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200">
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

            <span class="min-w-0 truncate text-sm font-semibold text-slate-900">
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
          </div>

          {/* Subtitle row */}
          <div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-slate-500">
            {subtitle ? (
              <span class="min-w-0 truncate" title={subtitle}>
                {subtitle}
              </span>
            ) : (
              <span class="text-slate-400">—</span>
            )}

            {hasSsh ? (
              <>
                <span class="text-slate-300">•</span>
                <span
                  class="inline-flex items-center gap-1 font-mono text-xs font-semibold tracking-wide text-indigo-500"
                  title="Connected via SSH tunnel"
                >
                  <Ssh className="h-3.5 w-3.5 text-slate-400" />
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

      <CardMenu
        open={menuOpen}
        anchorEl={kebabRef.current}
        point={menuPoint}
        onClose={closeMenu}
        onEdit={() => {
          closeMenu();
          onEdit();
        }}
        onDelete={() => {
          onDelete();
        }}
      />
    </div>
  );
});
