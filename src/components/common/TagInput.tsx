import { useMemo, useState } from "preact/hooks";
import { normalizeTag } from "src/utils/convert";
import { XIcon } from "../icons";
import { Button } from "./Button";

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

  function addTag(raw: string) {
    const t = normalizeTag(raw);
    if (!t) return;
    if (value.includes(t)) return;
    onChange([...value, t]);
  }

  function removeTag(t: string) {
    onChange(value.filter((x) => x !== t));
  }

  const filteredSuggestions = useMemo(() => {
    const q = input.trim().toLowerCase();

    // show either:
    // - input-filtered suggestions, or
    // - default suggestions when input empty
    const base = suggestions
      .map((s) => normalizeTag(s))
      .filter(Boolean)
      .filter((s, idx, arr) => arr.indexOf(s) === idx) // unique
      .filter((s) => !value.includes(s));

    const result = q ? base.filter((s) => s.toLowerCase().includes(q)) : base;

    return result.slice(0, maxSuggestions);
  }, [suggestions, value, input, maxSuggestions]);

  return (
    <div class="space-y-2">
      {/* Input field */}
      <div class="flex flex-wrap items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 focus-within:ring-2 focus-within:ring-blue-200">
        {value.map((t) => (
          <span
            key={t}
            class="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
            title={t}
          >
            <span class="max-w-45 truncate">{t}</span>
            <button
              type="button"
              class="text-slate-500 hover:text-slate-700"
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
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag(input);
              setInput("");
            } else if (e.key === "Backspace" && !input && value.length) {
              removeTag(value[value.length - 1]);
            }
          }}
        />
      </div>

      {/* Suggestions */}
      {filteredSuggestions.length ? (
        <div class="flex flex-wrap gap-2">
          {filteredSuggestions.map((s) => (
            <Button
              key={s}
              variant="outline"
              className="cursor-default rounded-full border-slate-300 px-3"
              onClick={() => {
                addTag(s);
                setInput("");
              }}
            >
              {s}
            </Button>
          ))}
        </div>
      ) : null}

      <div class="text-xs text-slate-500">
        Tip: press <b>Enter</b> or type <b>,</b> to add a tag.
      </div>
    </div>
  );
}
