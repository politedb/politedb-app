import React from "preact/compat";
import { cn } from "src/utils/cn";
import { Spinner } from "./Spinner";

type ButtonVariant =
  | "default"
  | "shadow"
  | "primary"
  | "outline"
  | "ghost"
  | "destructive"
  | "secondary";

interface ButtonProps extends React.ComponentProps<"button"> {
  className?: string;
  class?: string;
  variant?: ButtonVariant;
  active?: boolean;
  loading?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  default: "bg-blue-700 text-white hover:bg-blue-700/90 active:bg-blue-800",
  shadow: "shadow-sm hover:bg-neutral-100",
  primary:
    "bg-neutral-800/50 text-neutral-50 hover:bg-neutral-700 hover:text-white",
  outline:
    "text-neutral-600 bg-transparent hover:bg-neutral-100 active:bg-neutral-100",
  ghost:
    "text-neutral-700 bg-transparent hover:bg-neutral-200 active:bg-neutral-100",
  destructive: "bg-red-500 text-white hover:bg-red-600 active:bg-red-700",
  secondary: "bg-gray-500 text-white hover:bg-gray-600 active:bg-gray-700",
};

const activeStyles: Record<ButtonVariant, string> = {
  default: "bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-600/90",
  shadow: "border-neutral-200 shadow-md",
  primary: "bg-neutral-700 hover:bg-neutral-700 text-white",
  outline:
    "border-neutral-500 text-neutral-500 bg-transparent hover:bg-neutral-50 active:bg-neutral-100",
  ghost:
    "text-blue-500 border-transparent hover:border-blue-500 bg-transparent hover:bg-blue-50 active:bg-blue-100",
  destructive: "bg-red-500 text-white hover:bg-red-600 active:bg-red-700",
  secondary: "bg-gray-500 text-white hover:bg-gray-600 active:bg-gray-700",
};

const borderStyles: Record<ButtonVariant, string> = {
  default: "border-blue-700 hover:border-blue-700/90 active:border-blue-800",
  shadow: "border-neutral-300",
  primary:
    "border-neutral-500 hover:border-neutral-600 active:border-neutral-700",
  outline: "border-neutral-400",
  ghost:
    "border-transparent hover:border-neutral-200 active:border-neutral-100",
  destructive: "border-red-600 hover:border-red-600/90 active:border-red-700",
  secondary: "border-gray-500 hover:border-gray-600 active:border-gray-700",
};

const activeBorderStyles: Record<ButtonVariant, string> = {
  default: "border-blue-500 hover:border-blue-600 active:border-blue-600/90",
  shadow: "border-neutral-200",
  primary: "border-neutral-700 hover:border-neutral-700",
  outline: "border-neutral-500",
  ghost: "border-transparent hover:border-blue-500",
  destructive: "border-red-500 hover:border-red-600 active:border-red-700",
  secondary: "border-gray-500 hover:border-gray-600 active:border-gray-700",
};

export function Button({
  children,
  disabled,
  className,
  class: classNames,
  variant = "default",
  active = false,
  loading = false,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md px-4 py-1 text-xs font-medium transition-colors",
        "border disabled:cursor-not-allowed disabled:opacity-50",
        variantStyles[variant],
        borderStyles[variant],
        active && activeStyles[variant],
        active && activeBorderStyles[variant],
        className,
        classNames
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Spinner className="size-3.5" /> : children}
    </button>
  );
}
