import type { ComponentChildren } from "preact";
import { Button } from "./Button";
import { cn } from "src/utils/cn";

export interface TabItem<T extends string = string> {
  value: T;
  label: string;
  children: ComponentChildren;
}

export interface TabsProps<T extends string = string> {
  /** Current active tab value (controlled) */
  value: T;
  /** Called when user selects a tab */
  onValueChange: (value: T) => void;
  /** List of tabs: value, label, and content */
  tabs: TabItem<T>[];
  /** Optional class for the tab list bar */
  listClassName?: string;
  /** Optional class for the content wrapper */
  contentClassName?: string;
}

export function Tabs<T extends string = string>({
  value,
  onValueChange,
  tabs,
  listClassName,
  contentClassName,
}: TabsProps<T>) {
  const activeContent = tabs.find((t) => t.value === value)?.children ?? null;

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div
        class={cn("flex border-b border-neutral-200 bg-neutral-50", listClassName)}
      >
        {tabs.map((tab) => (
          <Button
            key={tab.value}
            variant="ghost"
            type="button"
            onClick={() => onValueChange(tab.value)}
            class={cn(
              "-mb-px rounded-none border-b-2 px-3 py-2 text-xs font-medium transition-colors hover:bg-transparent",
              value === tab.value
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
            )}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      <div class={cn("min-h-0 flex-1 overflow-hidden", contentClassName)}>
        {activeContent}
      </div>
    </div>
  );
}
