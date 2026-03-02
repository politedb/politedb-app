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
  error?: boolean;

  className?: string;
}) {
  const {
    value,
    placeholder = "Select file…",
    onPick,
    onClear,
    disabled,
    error,
    className,
  } = props;

  const hasValue = !!value?.trim();
  const display = hasValue ? basename(value) : placeholder;

  const borderCls = error
    ? "border-rose-300 focus:border-rose-400 focus:ring-rose-200/60"
    : "border-slate-300 focus:border-blue-400 focus:ring-blue-200/60";

  return (
    <div
      class={cn("relative w-full", disabled && "opacity-60", className)}
      title={hasValue ? value : undefined}
    >
      {/* Clickable main area */}
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled ? "true" : "false"}
        onClick={() => {
          if (disabled) return;
          void onPick();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void onPick();
          }
        }}
        class={cn(
          "flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border bg-white px-3 text-sm outline-none",
          borderCls,
          "focus:ring-2",
          disabled ? "cursor-not-allowed" : "hover:bg-slate-50"
        )}
      >
        <span
          class={cn(
            "min-w-0 flex-1 cursor-default truncate text-left",
            hasValue ? "font-medium text-slate-900" : "text-slate-400"
          )}
        >
          {display}
        </span>

        {!hasValue ? (
          <Folder className="size-4 shrink-0 text-slate-500" />
        ) : null}
      </div>

      {/* Clear button sits OUTSIDE the clickable div to avoid nested buttons */}
      {hasValue && onClear ? (
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClear();
          }}
          class={cn(
            "absolute top-1/2 right-2 -translate-y-1/2",
            "flex h-6 w-6 items-center justify-center rounded-md transition",
            error
              ? "text-rose-400 hover:bg-rose-100 hover:text-rose-700"
              : "text-slate-400 hover:bg-slate-200 hover:text-slate-700",
            disabled && "cursor-not-allowed"
          )}
          title="Clear"
          aria-label="Clear file path"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
