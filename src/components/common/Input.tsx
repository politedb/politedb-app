import { HTMLAttributes, TargetedEvent, TargetedFocusEvent } from "preact";
import { useState, useRef, useEffect, useCallback } from "preact/hooks";
import { cn } from "src/utils/cn";
import { MenuPopover, MenuItem } from "./MenuPopover";
import { ChevronSort } from "src/components/icons";

export type InputOption = string | { label: string; value: string };

export function Input(
  props: HTMLAttributes<HTMLInputElement> & {
    showSelect?: boolean;
    options?: InputOption[];
    value: string;
    label?: string;
    placeholder?: string;
    type?: string;
    error?: boolean;
    left?: React.ReactNode;
    right?: React.ReactNode;
    disabled?: boolean;
    readOnly?: boolean;
    onValueChange?: (value: string) => void;
  }
) {
  const {
    className,
    showSelect,
    options = [],
    value,
    label,
    onValueChange,
    onChange,
    onFocus,
    onBlur,
    readOnly,
    ...rest
  } = props;

  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Normalize options to always have label and value
  const normalizedOptions = options.map((opt) =>
    typeof opt === "string" ? { label: opt, value: opt } : opt
  );

  // // Filter options based on input value
  // const filteredOptions = normalizedOptions.filter((opt) =>
  //   opt.label.toLowerCase().includes(value.toLowerCase())
  // );

  const handleInputChange = (e: TargetedEvent<HTMLInputElement>) => {
    const target = e.currentTarget;
    onChange?.(e);
    onValueChange?.(target.value);
  };

  const handleFocus = useCallback(
    (e: TargetedFocusEvent<HTMLInputElement>) => {
      onFocus?.(e);
    },
    [onFocus]
  );

  const handleBlur = useCallback(
    (e: TargetedFocusEvent<HTMLInputElement>) => {
      onBlur?.(e);
    },
    [onBlur]
  );

  const handleSelectOption = (optionValue: string) => {
    onValueChange?.(optionValue);
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const handleToggleDropdown = useCallback(() => {
    if (!props.disabled) {
      setIsOpen(!isOpen);
    }
  }, [isOpen, props.disabled]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div ref={containerRef} class="relative">
      <div class="relative">
        {props.left && (
          <div class="absolute top-1/2 left-2 z-10 -translate-y-1/2">
            {props.left}
          </div>
        )}
        {label && <label class="mb-1 block text-sm font-medium">{label}</label>}
        <input
          ref={inputRef}
          {...rest}
          readOnly={readOnly}
          value={value}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          class={cn(
            "w-full rounded-md p-2 text-xs focus:bg-white focus:outline-2 focus:outline-blue-500",
            props.left && "pl-8",
            (showSelect || props.right) && "pr-8",
            className
          )}
        />
        {showSelect && (
          <button
            type="button"
            onClick={handleToggleDropdown}
            disabled={props.disabled}
            class={cn(
              "absolute top-1/2 right-2 z-10 -translate-y-1/2",
              "text-slate-400 hover:text-slate-600",
              props.disabled && "cursor-not-allowed opacity-50"
            )}
          >
            <ChevronSort className="size-4" />
          </button>
        )}
        {!showSelect && props.right && (
          <div class="absolute top-1/2 right-2 z-10 -translate-y-1/2">
            {props.right}
          </div>
        )}
      </div>
      {showSelect && isOpen && normalizedOptions.length > 0 && (
        <MenuPopover
          open={isOpen}
          onClose={() => setIsOpen(false)}
          anchorEl={containerRef.current}
          align="left"
          width={containerRef.current?.offsetWidth || 200}
        >
          <div class="max-h-60 overflow-y-auto py-1">
            {normalizedOptions.map((opt, index) => (
              <MenuItem
                key={`${opt.value}-${index}`}
                onClick={() => handleSelectOption(opt.value)}
              >
                {opt.label}
              </MenuItem>
            ))}
          </div>
        </MenuPopover>
      )}
    </div>
  );
}
