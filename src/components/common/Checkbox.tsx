import React from "preact/compat";
import { cn } from "src/utils/cn";

interface CheckboxProps extends Omit<React.ComponentProps<"input">, "type"> {
  className?: string;
  class?: string;
  label?: React.ReactNode;
  description?: React.ReactNode;
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
  ...props
}: CheckboxProps) {
  const inputId = id ?? `checkbox-${Math.random().toString(36).slice(2, 9)}`;
  const input = (
    <input
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
            "flex cursor-pointer items-center gap-2 text-sm text-neutral-700",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          {input}
          <span>{label ?? children}</span>
        </label>
        {description && <p class="text-xs text-neutral-600">{description}</p>}
      </div>
    );
  }

  return input;
}
