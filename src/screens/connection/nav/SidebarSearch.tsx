import { Input } from "src/components/common/Input";
import { SearchIcon, XIcon } from "src/components/icons";

/**
 * The search box at the top of a sidebar tab: Escape or the clear button
 * empties it.
 */
export function SidebarSearch(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  const { value, onChange, placeholder, label } = props;
  return (
    <div data-density-sidebar-header class="p-2">
      <Input
        type="text"
        placeholder={placeholder}
        aria-label={label}
        left={<SearchIcon className="size-4 text-neutral-500" />}
        right={
          value ? (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              class="flex size-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-800"
              onClick={() => onChange("")}
            >
              <XIcon className="size-3" />
            </button>
          ) : undefined
        }
        value={value}
        // Filter on every keystroke.
        onInput={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        className="rounded-lg border border-neutral-200 bg-white py-1.5 text-sm"
      />
    </div>
  );
}
