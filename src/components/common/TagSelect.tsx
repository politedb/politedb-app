import { useRef, useState } from "preact/hooks";
import { ChevronSort, X } from "src/components/icons";
import { cn } from "src/utils/cn";
import { MenuItem, MenuPopover } from "./MenuPopover";

interface Props {
  className?: string;
  label?: string;
  values: string[];
  onChange: (value: string) => void;
  options?: string[];
}

export function TagSelect(props: Props) {
  const { className, label, values, onChange, options } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  const [isOpen, setIsOpen] = useState(false);

  return (
    <div class={cn("flex items-center gap-2", className)}>
      {label && (
        <label class="text-xs font-semibold text-neutral-700">{label}</label>
      )}
      <div ref={containerRef} class="relative w-full">
        {/* Selected tags display */}
        <div
          class="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs focus-within:border-blue-500 focus-within:outline-2 focus-within:outline-blue-500"
          onClick={() => setIsOpen(!isOpen)}
        >
          {values.length > 0 ? (
            <>
              {values.map((key) => (
                <span
                  key={key}
                  class="flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(key);
                  }}
                >
                  {key}
                  <X className="size-3 hover:text-blue-900" />
                </span>
              ))}
            </>
          ) : (
            <span class="text-neutral-400">Select columns...</span>
          )}
          <ChevronSort
            className={cn(
              "ml-auto size-4 text-neutral-400",
              isOpen && "rotate-180"
            )}
          />
        </div>

        {/* Dropdown menu */}
        {isOpen && (
          <MenuPopover
            open={isOpen}
            onClose={() => setIsOpen(false)}
            anchorEl={containerRef.current}
            align="left"
            width={containerRef.current?.offsetWidth || 192}
            className="rounded-md"
          >
            <div class="max-h-60 overflow-y-auto py-1">
              {options && options.length > 0 ? (
                options.map((name) => (
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
                  No columns available
                </div>
              )}
            </div>
          </MenuPopover>
        )}
      </div>
    </div>
  );
}
