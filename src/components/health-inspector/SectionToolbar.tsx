import { useState } from "preact/hooks";
import type { TargetedEvent } from "preact";
import { Button } from "src/components/common/Button";
import { CopyCheckIcon, CopyIcon, SearchIcon } from "src/components/icons";
import { cn } from "src/utils/cn";

export type SectionFilterState = { query: string; flaggedOnly: boolean };

export const EMPTY_SECTION_FILTER: SectionFilterState = {
  query: "",
  flaggedOnly: false,
};

/**
 * Search box, optional "flagged only" toggle and a shown/total count for one
 * Health Inspector list. Escape clears a non-empty search before the dialog
 * sees it.
 */
export function SectionToolbar(props: {
  filter: SectionFilterState;
  onFilterChange: (next: SectionFilterState) => void;
  placeholder: string;
  shown: number;
  total: number;
  flag?: { label: string; count: number };
}) {
  const { filter, onFilterChange, flag } = props;
  const filtered = filter.query.trim() !== "" || filter.flaggedOnly;
  return (
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative w-64 max-w-full">
        <input
          type="search"
          value={filter.query}
          placeholder={props.placeholder}
          aria-label={props.placeholder}
          onInput={(e: TargetedEvent<HTMLInputElement>) =>
            onFilterChange({ ...filter, query: e.currentTarget.value })
          }
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter.query !== "") {
              e.stopPropagation();
              onFilterChange({ ...filter, query: "" });
            }
          }}
          class={cn(
            "h-8 w-full rounded-md border border-neutral-300 bg-white py-1 pr-2 pl-8 text-sm text-neutral-900",
            "outline-none placeholder:text-neutral-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500",
            "dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          )}
        />
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-neutral-400" />
      </div>
      {flag ? (
        <button
          type="button"
          aria-pressed={filter.flaggedOnly}
          disabled={flag.count === 0 && !filter.flaggedOnly}
          onClick={() =>
            onFilterChange({ ...filter, flaggedOnly: !filter.flaggedOnly })
          }
          class={cn(
            "h-8 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            filter.flaggedOnly
              ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
              : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          )}
        >
          {flag.label} ({flag.count})
        </button>
      ) : null}
      <span
        class="text-xs text-neutral-500 dark:text-neutral-400"
        aria-live="polite"
      >
        {filtered ? `${props.shown} of ${props.total}` : `${props.total} rows`}
      </span>
    </div>
  );
}

/** Copies a maintenance statement; the Inspector never runs it. */
export function CopySqlButton(props: { sql: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(props.sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1000);
    } catch {
      // Clipboard access can be unavailable in restricted contexts.
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-6 shrink-0 gap-1 px-1.5 text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-300"
      onClick={(event) => void handleCopy(event)}
      title={props.sql}
      aria-label={copied ? "Copied" : props.label}
    >
      {copied ? (
        <CopyCheckIcon className="size-3.5 text-green-700" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
      {props.label}
    </Button>
  );
}
