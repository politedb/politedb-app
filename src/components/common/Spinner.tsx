import { cn } from "src/utils/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      class={cn(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent",
        className
      )}
    />
  );
}
