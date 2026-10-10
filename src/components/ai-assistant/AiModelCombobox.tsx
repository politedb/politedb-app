import { createPortal } from "preact/compat";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { cn } from "src/utils/cn";

const MAX_VISIBLE = 50;
const LIST_MAX_HEIGHT = 240;
const GAP = 4;

type ListPosition = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

/**
 * Fixed position next to the input, rendered in a portal so dialog overflow and
 * scroll areas never clip it. Opens upward when there is more room above.
 */
function listPositionFor(input: HTMLElement): ListPosition {
  const rect = input.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - GAP * 2;
  const above = rect.top - GAP * 2;
  const openUp = below < 160 && above > below;
  return {
    left: rect.left,
    width: rect.width,
    ...(openUp
      ? { bottom: window.innerHeight - rect.top + GAP }
      : { top: rect.bottom + GAP }),
    maxHeight: Math.max(96, Math.min(LIST_MAX_HEIGHT, openUp ? above : below)),
  };
}

/**
 * Model id input with filtered suggestions. Enter or click adds the highlighted
 * suggestion, or the typed id when nothing is highlighted; any id can be added.
 */
export function AiModelCombobox(props: {
  suggestions: string[];
  /** Already selected ids; hidden from suggestions. */
  selected: string[];
  onAdd: (model: string) => void;
  /** Changing this focuses the input and opens the suggestions (e.g. after Load models). */
  focusRequest?: number;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<ListPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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
  const showList = open && rows.length > 0;

  useEffect(() => {
    if (!props.focusRequest) return;
    inputRef.current?.focus();
    setOpen(true);
  }, [props.focusRequest]);

  // Follow the input while the list is open (dialog scroll, window resize).
  useLayoutEffect(() => {
    if (!showList || !inputRef.current) return;
    const update = () =>
      inputRef.current && setPosition(listPositionFor(inputRef.current));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [showList]);

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
    } else if (event.key === "Escape" && showList) {
      // Close only the list, not the surrounding dialog.
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div class="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showList}
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
      {showList && position
        ? createPortal(
            <ul
              id={listId}
              role="listbox"
              // Portaled outside the assistant: mark it so the floating assistant's
              // outside-click handler treats clicks here as inside (it would close).
              data-ai-assistant-popover="true"
              class="fixed z-[1100] overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
              style={{
                left: position.left,
                width: position.width,
                top: position.top,
                bottom: position.bottom,
                maxHeight: position.maxHeight,
              }}
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
            </ul>,
            document.body
          )
        : null}
    </div>
  );
}
