import React from "preact/compat";
import { useEffect, useRef } from "preact/hooks";
import { cn } from "src/utils/cn";

interface CheckboxProps extends Omit<React.ComponentProps<"input">, "type"> {
  className?: string;
  class?: string;
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Visual mixed state; does not change the checked value itself. */
  indeterminate?: boolean;
}

export function Checkbox({
  checked,
  onChange,
  disabled,
  className,
  class: classNames,
  label,
  id,
  children,
  description,
  indeterminate = false,
  ...props
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = id ?? `checkbox-${Math.random().toString(36).slice(2, 9)}`;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = !!indeterminate;
    }
  }, [indeterminate, checked]);

  const input = (
    <input
      ref={inputRef}
      type="checkbox"
      id={inputId}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      class={cn(
        "size-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 focus:ring-offset-0",
        disabled && "cursor-not-allowed opacity-50",
        className,
        classNames
      )}
      {...props}
    />
  );

  if (label != null || children) {
    return (
      <div class="space-y-1">
        <label
          htmlFor={inputId}
          class={cn(
            "flex cursor-pointer items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          {input}
          <span>{label ?? children}</span>
        </label>
        {description && (
          <p class="text-xs text-neutral-600 dark:text-neutral-400">
            {description}
          </p>
        )}
      </div>
    );
  }

  return input;
}
