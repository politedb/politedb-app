import { useCallback, useMemo, useRef, useState } from "preact/hooks";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import {
  CopyIcon,
  EditIcon,
  KeyIcon,
  SparklesIcon,
  SshIcon,
  TrashIcon,
} from "src/components/icons";
import { DbIcon } from "src/components/icons/DbIcon";
import type { KeychainDisplay, KeychainIcon } from "src/lib/keychain/display";
import { cn } from "src/utils/cn";
import { confirmDialog } from "src/lib/system-dialog";
import { KebabButton } from "../../components/common/KebabButton";

export function KeychainCard(props: {
  keyName: string;
  /** From `keychainDisplay`; the raw key name stays the identity. */
  display: KeychainDisplay;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { keyName, selected, disabled, onSelect, onOpen, onCopy, onDelete } =
    props;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const { title, badge, detail, icon, unused } = props.display;

  const onDeleteSecret = useCallback(async () => {
    const ok = await confirmDialog(
      `Delete "${title}"? This removes the saved secret from the system keychain and cannot be undone.`,
      {
        title: "Delete keychain secret",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      }
    );
    if (!ok) return;
    onDelete();
  }, [onDelete, title]);

  const menuItems = useMemo<MenuItem[]>(
    () => [
      {
        type: "item",
        label: "Edit",
        color: "slate",
        icon: <EditIcon className="size-4" />,
        disabled,
        onClick: onOpen,
      },
      {
        type: "item",
        label: "Copy name",
        color: "slate",
        icon: <CopyIcon className="size-4" />,
        onClick: onCopy,
      },
      { type: "sep" },
      {
        type: "item",
        label: "Delete",
        disabled,
        onClick: onDeleteSecret,
        color: "red",
        icon: <TrashIcon className="size-4" />,
      },
    ],
    [disabled, onCopy, onDeleteSecret, onOpen]
  );

  const openMenuAtAnchor = useCallback((e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setMenu({ x: rect.left - 150, y: rect.bottom + 6 });
    }
  }, []);

  // Right-click anywhere on the card opens the same menu at the pointer.
  const openMenuAtPoint = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        title={keyName}
        onClick={onSelect}
        // While another keychain operation runs, a card must not start a read.
        onDblClick={disabled ? undefined : onOpen}
        onContextMenu={openMenuAtPoint}
        onKeyDown={(e) => {
          // Keys on the card's ⋮ button are its own.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
            openMenuAtAnchor(e);
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
        <div class="relative z-10 flex min-w-0 flex-1 items-center gap-3">
          <div
            class={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1",
              unused
                ? "bg-amber-50 ring-amber-200"
                : "bg-slate-50 ring-slate-200"
            )}
          >
            <KeychainCardIcon icon={icon} />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm font-semibold text-slate-800">
                {title}
              </span>
              {badge ? (
                <span class="shrink-0 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] leading-none font-medium text-slate-600">
                  {badge}
                </span>
              ) : null}
            </div>
            {detail ? (
              <div class="mt-1 truncate text-xs text-slate-500">{detail}</div>
            ) : null}
            {/* The raw key tells apart cards that read the same (two unused keys). */}
            <span class="sr-only">Key name: {keyName}</span>
          </div>
        </div>

        <KebabButton
          menuOpen={menu !== null}
          onClick={openMenuAtAnchor}
          buttonRef={btnRef}
          label={title}
        />
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
        autoFocus
      />
    </>
  );
}

function KeychainCardIcon(props: { icon: KeychainIcon }) {
  const { icon } = props;
  switch (icon.kind) {
    case "database":
      // Decorative: the badge already names the engine.
      return <DbIcon engine={icon.engine} size="sm" alt="" />;
    case "ssh":
      return <SshIcon className="size-6 text-slate-700" />;
    case "ai":
      return (
        <SparklesIcon className="size-6 text-violet-600 dark:text-violet-400" />
      );
    default:
      return <KeyIcon className="size-6 text-slate-700" />;
  }
}
