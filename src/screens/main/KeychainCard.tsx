import { useMemo, useRef, useState } from "preact/hooks";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import {
  CopyIcon,
  EditIcon,
  KeyIcon,
  MoreVerticalIcon,
  TrashIcon,
} from "src/components/icons";
import { cn } from "src/utils/cn";

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
        onClick: onDelete,
        color: "red",
        icon: <TrashIcon className="size-4" />,
      },
    ],
    [disabled, onCopy, onDelete, onOpen]
  );

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          onSelect();
          onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
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

        <div class="relative z-10 flex items-center gap-1">
          <button
            ref={btnRef}
            type="button"
            aria-label="Open key menu"
            class={cn(
              "rounded-full p-2 text-slate-400 transition",
              "hover:bg-slate-100 hover:text-slate-700",
              menu
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus:opacity-100"
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const rect = btnRef.current?.getBoundingClientRect();
              if (rect) {
                setMenu({ x: rect.left, y: rect.bottom + 6 });
              }
            }}
          >
            <MoreVerticalIcon className="size-5" />
          </button>
        </div>
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
