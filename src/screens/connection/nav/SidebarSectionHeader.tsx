import {
  ChevronDownIcon,
  ChevronRightIcon,
  ListIcon,
} from "src/components/icons";
import { cn } from "src/utils/cn";

/**
 * A collapsible sidebar section's header: the whole row expands or
 * collapses it, with how many items it holds, and an optional button (shown
 * on hover or focus) that opens the full list.
 */
export function SidebarSectionHeader(props: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  count?: number;
  /** Opens the section's full list, e.g. every table with sizes. */
  onOpenList?: () => void;
}) {
  const { title, expanded, onToggle, count, onOpenList } = props;
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div class="group/section relative flex items-center">
      <button
        type="button"
        data-density-item
        aria-expanded={expanded}
        class={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left",
          "hover:bg-neutral-200/60 active:bg-neutral-200/60",
          "focus-visible:outline-2 focus-visible:outline-blue-500/60",
          onOpenList && "pr-8"
        )}
        onClick={onToggle}
      >
        <Chevron className="size-3.5 shrink-0 text-neutral-500" />
        <span class="min-w-0 truncate text-sm font-semibold tracking-wide text-neutral-600">
          {title}
        </span>
        {count !== undefined ? (
          <span class="shrink-0 text-xs font-normal text-neutral-500 tabular-nums">
            {count}
          </span>
        ) : null}
      </button>
      {onOpenList ? (
        <button
          type="button"
          aria-label={`Show all ${title.toLowerCase()} in a list`}
          title={`Show all ${title.toLowerCase()} in a list`}
          class={cn(
            "absolute right-1 flex size-6 items-center justify-center rounded text-neutral-500",
            "hover:bg-neutral-200/60 hover:text-neutral-800",
            "focus-visible:outline-2 focus-visible:outline-blue-500/60",
            "opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100"
          )}
          onClick={onOpenList}
        >
          <ListIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
