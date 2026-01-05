import { Folder, X } from "../icons";
import { cn } from "src/utils/cn";

function basename(path: string) {
  if (!path) return "";
  const p = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function FilePathPicker(props: {
  value: string;
  placeholder?: string;
  onPick: () => void | Promise<void>;
  onClear?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const {
    value,
    placeholder = "Select file…",
    onPick,
    onClear,
    disabled,
    className,
  } = props;

  const hasValue = !!value?.trim();
  const display = hasValue ? basename(value) : placeholder;

  return (
    <div
      class={cn(
        "group relative w-full",
        disabled && "pointer-events-none opacity-60",
        className
      )}
      title={hasValue ? value : undefined} // tooltip native = full path
    >
      <button
        onClick={onPick}
        type="button"
        class={cn(
          "flex h-10 w-full min-w-0 items-center gap-2",
          "rounded-lg border border-slate-300 bg-white px-3",
          "text-sm hover:bg-slate-50",
          "focus:ring-2 focus:ring-blue-200 focus:outline-none"
        )}
      >
        {/* Filename / placeholder */}
        <span
          class={cn(
            "min-w-0 flex-1 truncate text-left",
            hasValue ? "font-medium text-slate-900" : "text-slate-400"
          )}
        >
          {display}
        </span>

        {/* Clear */}
        {hasValue && onClear ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClear();
            }}
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-200 hover:text-slate-700"
            title="Clear"
          >
            <X className="size-3" />
          </button>
        ) : null}

        {/* Folder icon */}
        {!hasValue ? (
          <Folder className="size-4 shrink-0 text-slate-500" />
        ) : null}
      </button>
    </div>
  );
}
