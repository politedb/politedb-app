import React from "preact/compat";
import { cn } from "../../utils/cn";

interface SelectProps extends React.ComponentProps<"select"> {
  className?: string;
  class?: string;
}

export function Select({
  children,
  className,
  class: classNames,
  ...props
}: SelectProps) {
  return (
    <select
      className={cn(
        "h-8 w-full rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900 outline-none",
        "focus:border-blue-400 focus:ring-4 focus:ring-blue-200/60",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "cursor-pointer",
        className,
        classNames
      )}
      {...props}
    >
      {children}
    </select>
  );
}
