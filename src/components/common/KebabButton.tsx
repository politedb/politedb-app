import { memo, RefObject } from "preact/compat";
import { MoreVerticalIcon } from "../icons/MoreVertical";

export const KebabButton = memo(function KebabButton(props: {
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
