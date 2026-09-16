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
    "w-full justify-start rounded-md border px-2.5 py-1.5 gap-2 text-left text-sm font-medium overflow-hidden text-ellipsis select-none transition-none";

  if (opts.isActive) {
    return cn(
      base,
      "border-blue-500 bg-blue-500",
      "hover:border-blue-500/90 hover:bg-blue-500/90 active:border-blue-600 active:bg-blue-600",
      "dark:border-blue-500 dark:bg-blue-500 dark:hover:bg-blue-500 dark:active:bg-blue-500"
    );
  }

  if (opts.isActive && opts.hasChanges) {
    return cn(
      base,
      "border-amber-200 bg-amber-200 text-neutral-600",
      "hover:border-amber-200 hover:bg-amber-200/80 active:border-amber-200 active:bg-amber-200/90",
      "dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-500/80 dark:active:bg-amber-500/90"
    );
  }

  if (opts.isActive && opts.isNewTable) {
    return cn(
      base,
      "border-green-200 bg-green-200",
      "hover:border-green-200 hover:bg-green-200/80 active:border-green-200 active:bg-green-200/90",
      "dark:border-green-500 dark:bg-green-500 dark:hover:bg-green-500/80 dark:active:bg-green-500/90"
    );
  }

  return cn(
    base,
    "border-transparent",
    "hover:border-neutral-200/60 hover:bg-neutral-200/60 active:bg-neutral-200/60",
    "dark:hover:border-neutral-800/60",
    opts.isNewTable && "bg-green-200 text-emerald-900 active:bg-green-200/90",
    opts.hasChanges && "bg-amber-200 text-amber-500 active:bg-amber-200/90"
  );
}

export function tableSidebarIconClass(opts: {
  isActive: boolean;
  isRedis: boolean;
}) {
  if (opts.isActive) return "text-white";

  return opts.isRedis ? "text-amber-500" : "text-blue-500";
}
