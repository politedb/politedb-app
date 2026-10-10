import { useMemo, useRef, useState } from "preact/hooks";
import { cn } from "src/utils/cn";

const MAX_VISIBLE = 50;

/**
 * Model id input with filtered suggestions. Enter or click adds the highlighted
 * suggestion, or the typed id when nothing is highlighted; any id can be added.
 */
export function AiModelCombobox(props: {
  suggestions: string[];
  /** Already selected ids; hidden from suggestions. */
  selected: string[];
  onAdd: (model: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useRef(
    `ai-model-options-${Math.random().toString(36).slice(2, 8)}`
  ).current;

  const typed = query.trim();
  const options = useMemo(() => {
    const taken = new Set(props.selected);
    const needle = typed.toLowerCase();
    const matches = Array.from(new Set(props.suggestions))
      .filter((id) => !taken.has(id))
      .filter((id) => !needle || id.toLowerCase().includes(needle))
      .slice(0, MAX_VISIBLE);
    const exact = matches.some((id) => id === typed) || taken.has(typed);
    return { matches, custom: typed && !exact ? typed : null };
  }, [props.suggestions, props.selected, typed]);

  const rows = [
    ...options.matches,
    ...(options.custom ? [options.custom] : []),
  ];

  const add = (model: string) => {
    const value = model.trim();
    if (!value) return;
    props.onAdd(value);
    setQuery("");
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      add(active >= 0 && rows[active] ? rows[active] : typed);
    } else if (event.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div class="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open && rows.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder="Search or type a model ID"
        value={query}
        class="h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && rows.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          class="absolute top-full right-0 left-0 z-20 mt-1 max-h-60 overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
        >
          {rows.map((model, index) => {
            const isCustom =
              model === options.custom && index === rows.length - 1;
            return (
              <li
                key={`${isCustom ? "custom" : "option"}:${model}`}
                role="option"
                aria-selected={index === active}
                class={cn(
                  "cursor-pointer truncate px-3 py-1.5 text-sm",
                  index === active
                    ? "bg-blue-50 text-blue-700"
                    : "text-neutral-700 hover:bg-neutral-100"
                )}
                // mousedown keeps focus in the input so blur does not close first.
                onMouseDown={(event) => {
                  event.preventDefault();
                  add(model);
                }}
                onMouseEnter={() => setActive(index)}
              >
                {isCustom ? `Add "${model}"` : model}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
