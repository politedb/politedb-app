import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ChevronSortIcon, XIcon } from "src/components/icons";
import { cn } from "src/utils/cn";
import { MenuItem, MenuPopover } from "./MenuPopover";

interface Props {
  className?: string;
  label?: string;
  values: string[];
  onChange: (value: string) => void;
  options?: string[];
  disabled?: boolean;
  enableSearch?: boolean;
}

export function TagSelect(props: Props) {
  const {
    className,
    label,
    values,
    onChange,
    options,
    disabled = false,
    enableSearch = false,
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredOptions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return options ?? [];

    return (options ?? []).filter((option) =>
      option.toLowerCase().includes(normalizedQuery)
    );
  }, [options, searchQuery]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery("");
    }
  }, [isOpen]);

  return (
    <div class={cn("flex items-center gap-2", className)}>
      {label && (
        <label class="text-xs font-semibold text-neutral-700">{label}</label>
      )}
      <div ref={containerRef} class="relative w-full">
        {/* Selected tags display */}
        <div
          class={cn(
            "flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs",
            !disabled &&
              "focus-within:border-blue-500 focus-within:outline-2 focus-within:outline-blue-500",
            disabled && "cursor-not-allowed bg-neutral-100 text-neutral-400"
          )}
          onClick={() => {
            if (disabled) return;
            setIsOpen(!isOpen);
          }}
        >
          {values.length > 0 ? (
            <>
              {values.map((key) => (
                <span
                  key={key}
                  class="flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700"
                  onClick={(e) => {
                    if (disabled) return;
                    e.stopPropagation();
                    onChange(key);
                  }}
                >
                  {key}
                  <XIcon className="size-3 hover:text-blue-900" />
                </span>
              ))}
            </>
          ) : (
            <span class="text-neutral-400">Select columns...</span>
          )}
          <ChevronSortIcon
            className={cn(
              "ml-auto size-4 text-neutral-400",
              isOpen && "rotate-180",
              disabled && "opacity-60"
            )}
          />
        </div>

        {/* Dropdown menu */}
        {isOpen && !disabled && (
          <MenuPopover
            open={isOpen}
            onClose={() => setIsOpen(false)}
            anchorEl={containerRef.current}
            align="left"
            width={containerRef.current?.offsetWidth || 192}
            className="rounded-md"
          >
            <div>
              {enableSearch ? (
                <div class="border-b border-neutral-200 p-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onInput={(e) => setSearchQuery(e.currentTarget.value)}
                    placeholder="Search columns..."
                    class="w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-blue-500 focus:outline-2 focus:outline-blue-500"
                    autoFocus
                  />
                </div>
              ) : null}
              <div class="max-h-60 overflow-y-auto py-1">
                {filteredOptions.length > 0 ? (
                  filteredOptions.map((name) => (
                    <MenuItem
                      key={name}
                      onClick={() => onChange(name)}
                      right={
                        values.includes(name) ? (
                          <span class="text-blue-600">✓</span>
                        ) : null
                      }
                    >
                      {name}
                    </MenuItem>
                  ))
                ) : (
                  <div class="px-3 py-2 text-xs text-neutral-500">
                    {options && options.length > 0
                      ? "No matching columns"
                      : "No columns available"}
                  </div>
                )}
              </div>
            </div>
          </MenuPopover>
        )}
      </div>
    </div>
  );
}
