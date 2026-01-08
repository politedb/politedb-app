import { cn } from "../../utils/cn";

export function Box({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      class={cn(
        "flex h-full flex-col items-center justify-center bg-white",
        className
      )}
    >
      {children}
    </div>
  );
}
