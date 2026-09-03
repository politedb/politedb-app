import { cn } from "src/utils/cn";

export function MetaPill({
  text,
  className,
  title,
  tone = "neutral",
}: {
  text: string;
  className?: string;
  title?: string;
  tone?: "neutral" | "blue" | "green" | "amber";
}) {
  if (!text) return null;

  const cls =
    tone === "blue"
      ? "bg-blue-50 text-blue-700 border-blue-200/70"
      : tone === "green"
        ? "bg-emerald-50 text-emerald-700 border-emerald-200/70"
        : tone === "amber"
          ? "bg-amber-50 text-amber-700 border-amber-200/70"
          : "bg-neutral-50 text-neutral-600 border-neutral-200";

  return (
    <span
      title={title}
      class={cn(
        "inline-flex h-5 items-center rounded-md border px-1.5 text-xs font-semibold",
        "shadow-[0_1px_0_rgba(0,0,0,0.02)]",
        "dark:shadow-[0_1px_0_rgba(255,255,255,0.02)]",
        cls,
        className
      )}
    >
      {text}
    </span>
  );
}
