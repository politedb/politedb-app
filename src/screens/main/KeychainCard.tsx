import { useCallback, useMemo, useRef, useState } from "preact/hooks";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import { CopyIcon, EditIcon, KeyIcon, TrashIcon } from "src/components/icons";
import { cn } from "src/utils/cn";
import { KebabButton } from "../../components/common/KebabButton";

function parseKeyName(keyName: string) {
  const parts = keyName.split(":").filter(Boolean);
  const labelParts = parts[parts.length - 1].split("/").slice(-3);
  const label = labelParts.slice(-2).join("/") || keyName;

  return { label, tag: labelParts[0] };
}

export function KeychainCard(props: {
  keyName: string;
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

  const { label, tag } = useMemo(() => parseKeyName(keyName), [keyName]);

  const onDeleteSecret = useCallback(async () => {
    const ok = await Promise.resolve(
      window.confirm(
        `Delete keychain secret?\n\nThis will remove the saved keychain.`
      )
    );
    if (!ok) return;
    onDelete();
  }, [onDelete]);

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

  const openMenuAtAnchor = useCallback((e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      setMenu({ x: rect.left - 150, y: rect.bottom + 6 });
    }
  }, []);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onDblClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
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
          <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 ring-1 ring-blue-200">
            <KeyIcon className="size-6 text-slate-700" />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex flex-col justify-start gap-1">
              <div class="truncate text-sm font-semibold text-slate-800">
                {label}
              </div>
              <span class="text-xs text-neutral-600">{tag}</span>
            </div>
          </div>
        </div>

        <KebabButton
          menuOpen={menu !== null}
          onClick={openMenuAtAnchor}
          buttonRef={btnRef}
        />
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    </>
  );
}
