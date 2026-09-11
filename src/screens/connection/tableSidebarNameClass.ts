export function tableSidebarNameClass(opts: {
  isActive: boolean;
  isNewTable: boolean;
  hasChanges: boolean;
}) {
  if (opts.isActive && opts.hasChanges)
    return "bg-amber-200! text-neutral-600!";
  if (opts.isActive && opts.isNewTable)
    return "bg-green-200! text-emerald-900!";
  return undefined;
}
