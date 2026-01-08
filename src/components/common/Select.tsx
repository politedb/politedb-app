import React from "preact/compat";
import { cn } from "src/utils/cn";

interface SelectProps extends React.ComponentProps<"select"> {
  error?: boolean;
}

export function Select({
  children,
  error,
  className,
  class: classNames,
  disabled,
  ...props
}: SelectProps) {
  return (
    <select
      {...props}
      disabled={disabled}
      className={cn(
        // base
        "h-9 w-full rounded-lg border px-3 text-sm font-medium outline-none",
        "bg-white text-slate-900",
        "placeholder:text-slate-400",

        // state
        error
          ? "border-rose-300 bg-rose-50 focus:border-rose-400 focus:ring-2 focus:ring-rose-200/60"
          : "border-slate-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-200/60",

        // disabled
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",

        className,
        classNames
      )}
    >
      {children}
    </select>
  );
}
