import { useId, useMemo, useState } from "preact/hooks";
import { normalizeTag } from "src/utils/convert";
import { TagIcon, XIcon } from "../icons";
import { cn } from "src/utils/cn";
import { tagTone } from "./TagChips";

type TagOption = { tag: string; create: boolean; tone?: string };

/** Identity of an option that survives the list changing around it. */
const optionKey = (o: TagOption) => `${o.create ? "create" : "tag"}:${o.tag}`;

export function TagInput(props: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;

  suggestions?: string[];
  maxSuggestions?: number; // default 8
}) {
  const {
    value,
    onChange,
    placeholder = "Add tag…",
    suggestions = [],
    maxSuggestions = 8,
  } = props;

  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  // The option picked with the arrow keys or the pointer, by identity, so
  // removing a chip or new suggestions never move it onto another tag.
  const [active, setActive] = useState<string | null>(null);
  const listId = useId();

  function addTag(raw: string) {
    const t = normalizeTag(raw);
    if (!t) return;
    if (value.includes(t)) return;
    onChange([...value, t]);
  }

  function removeTag(t: string) {
    onChange(value.filter((x) => x !== t));
  }

  const options = useMemo<TagOption[]>(() => {
    const q = input.trim().toLowerCase();
    const typed = normalizeTag(input);

    const matches = suggestions
      .map((s) => normalizeTag(s))
      .filter(Boolean)
      .filter((s, idx, arr) => arr.indexOf(s) === idx) // unique
      .filter((s) => !value.includes(s))
      .filter((s) => !q || s.includes(q))
      // An exact match goes first.
      .sort((a, b) => Number(b === typed) - Number(a === typed))
      .slice(0, maxSuggestions);

    // "Create Tag" comes first so Enter keeps adding what was typed.
    const canCreate =
      !!typed && !value.includes(typed) && !matches.includes(typed);
    return [
      ...(canCreate ? [{ tag: typed, create: true }] : []),
      ...matches.map((tag) => ({ tag, create: false, tone: tagTone(tag) })),
    ];
  }, [suggestions, value, input, maxSuggestions]);

  // Without navigation, the option equal to the typed text ("Create Tag" or
  // an exact suggestion) is highlighted, which is what Enter adds.
  const typed = normalizeTag(input);
  const activeIndex =
    active === null ? -1 : options.findIndex((o) => optionKey(o) === active);
  const navigated = activeIndex >= 0;
  const highlighted = navigated
    ? activeIndex
    : typed
      ? options.findIndex((o) => o.tag === typed)
      : -1;
  const showList = open && options.length > 0;

  function choose(option: TagOption) {
    addTag(option.tag);
    setInput("");
    setActive(null);
  }

  function onKeyDown(e: KeyboardEvent) {
    // Leave every key to the input method while a composition is in progress
    // (Safari reports the confirming Enter as keyCode 229).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!options.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const from = showList ? highlighted : -1;
      const next =
        from < 0
          ? step > 0
            ? 0
            : options.length - 1
          : (from + step + options.length) % options.length;
      setActive(optionKey(options[next]!));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Without navigation Enter adds the typed text, as before; a duplicate
      // is a no-op rather than a different suggestion.
      if (showList && navigated) choose(options[activeIndex]!);
      else if (input.trim()) choose({ tag: input, create: true });
    } else if (e.key === ",") {
      e.preventDefault();
      if (input.trim()) choose({ tag: input, create: true });
    } else if (e.key === "Escape" && showList) {
      // Close the list without closing the dialog around it.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(null);
    } else if (e.key === "Backspace" && !input && value.length) {
      removeTag(value[value.length - 1]!);
    }
  }

  return (
    <div class="relative">
      <div
        class={cn(
          "flex min-h-10 flex-wrap items-center gap-1 rounded-xl border border-slate-300 bg-white px-2 py-2",
          "focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-200/60"
        )}
      >
        <TagIcon className="size-4 shrink-0 text-slate-400" aria-hidden />
        {value.map((t) => (
          <span
            key={t}
            class="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.75 text-xs font-medium text-slate-700"
            title={t}
          >
            <span class="max-w-45 truncate">{t}</span>
            <button
              type="button"
              class="leading-0 text-slate-500 hover:text-slate-700"
              onClick={() => removeTag(t)}
              aria-label={`Remove tag ${t}`}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}

        <input
          value={input}
          placeholder={value.length ? "" : placeholder}
          class="min-w-20 flex-1 border-none bg-transparent text-sm outline-none"
          role="combobox"
          aria-label="Tags"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={
            showList && highlighted >= 0
              ? `${listId}-${highlighted}`
              : undefined
          }
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(null);
          }}
          onInput={(e) => {
            const next = e.currentTarget.value;
            setInput(next);
            setOpen(true);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Tag options"
          class="absolute top-full right-0 left-0 z-50 mt-1.5 max-h-60 overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
        >
          {options.map((option, index) => (
            <li
              key={optionKey(option)}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              class={cn(
                "cursor-default truncate rounded-lg px-2 py-1.5 text-sm text-slate-800",
                index === highlighted && "bg-slate-100"
              )}
              // Keep focus in the input so the list stays open.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(optionKey(option))}
              onClick={() => choose(option)}
            >
              <div class="flex items-center justify-between gap-1">
                {option.create ? (
                  <p class="max-w-[80%] overflow-hidden text-ellipsis whitespace-nowrap">
                    <span class="text-slate-500">Create Tag</span> {option.tag}
                  </p>
                ) : (
                  option.tag
                )}
                <span
                  class={cn(
                    "h-4 w-10 rounded-md border",
                    option.tone || "border-slate-300"
                  )}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div class="mt-1 text-xs text-slate-500">
        Tip: press <b>Enter</b> or type <b>,</b> to add a tag.
      </div>
    </div>
  );
}
