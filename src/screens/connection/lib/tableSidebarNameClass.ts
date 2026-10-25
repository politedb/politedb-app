import { cn } from "src/utils/cn";

export function tableSidebarNameClass(opts: {
  isActive: boolean;
  isNewTable: boolean;
  hasChanges: boolean;
}) {
  if (opts.isActive && opts.hasChanges)
    return "bg-amber-200! text-neutral-900!";
  if (opts.isActive && opts.isNewTable)
    return "bg-green-200! text-emerald-900!";
  return undefined;
}

export function tableSidebarButtonClass(opts: {
  isActive: boolean;
  isNewTable: boolean;
  hasChanges: boolean;
}) {
  const base =
    "w-full justify-start rounded-md border px-2.5 py-1.5 gap-2 text-left text-sm font-medium overflow-hidden text-ellipsis select-none transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-400";

  // The active row stays blue; dirty and new colors go on its name chip
  // (tableSidebarNameClass).
  if (opts.isActive) {
    return cn(
      base,
      "border-blue-500 bg-blue-500",
      "hover:border-blue-500/90 hover:bg-blue-500/90 active:border-blue-600 active:bg-blue-600",
      "dark:border-blue-500 dark:bg-blue-500 dark:hover:bg-blue-500 dark:active:bg-blue-500"
    );
  }

  return cn(
    base,
    "border-transparent",
    "hover:border-neutral-200/60 hover:bg-neutral-200/60 active:bg-neutral-200/60",
    "dark:hover:border-neutral-800/60",
    opts.isNewTable && "bg-green-200 text-emerald-900 active:bg-green-200/90",
    opts.hasChanges && "bg-amber-200 text-amber-900 active:bg-amber-200/90"
  );
}

export function tableSidebarIconClass(opts: {
  isActive: boolean;
  isRedis: boolean;
}) {
  if (opts.isActive) return "text-white";

  return opts.isRedis ? "text-amber-500" : "text-blue-500";
}
