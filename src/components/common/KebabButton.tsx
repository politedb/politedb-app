import { memo, RefObject } from "preact/compat";
import { MoreVerticalIcon } from "../icons/MoreVertical";

export const KebabButton = memo(function KebabButton(props: {
  menuOpen: boolean;
  onClick: (e: MouseEvent) => void;
  buttonRef: RefObject<HTMLButtonElement>;
  /** What the menu belongs to: "Options for <label>" for screen readers. */
  label?: string;
}) {
  const { menuOpen, onClick, buttonRef, label } = props;

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      }}
      aria-label={label ? `Options for ${label}` : "Open menu"}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      class={[
        "rounded-full p-2 text-slate-400 transition",
        "hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200",
        menuOpen
          ? "opacity-100"
          : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100",
      ].join(" ")}
    >
      <MoreVerticalIcon className="size-5" />
    </button>
  );
});
