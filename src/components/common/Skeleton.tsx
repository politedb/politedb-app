import { cn } from "src/utils/cn";

type SkeletonProps = {
  className?: string;
};

/** Pulse placeholder block. Match layout with width/height utilities. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      class={cn(
        "animate-pulse rounded-md bg-neutral-200 dark:bg-neutral-700",
        className
      )}
      aria-hidden="true"
    />
  );
}
