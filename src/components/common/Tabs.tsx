import type { ComponentChildren } from "preact";
import { Button } from "./Button";
import { cn } from "src/utils/cn";

export interface TabItem<T extends string = string> {
  value: T;
  label: string;
  /** Optional count or status shown after the label (part of its name). */
  badge?: ComponentChildren;
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
  /** When true, non-active tabs cannot be selected */
  disabled?: boolean;
}

export function Tabs<T extends string = string>({
  value,
  onValueChange,
  tabs,
  listClassName,
  contentClassName,
  disabled = false,
}: TabsProps<T>) {
  const activeContent = tabs.find((t) => t.value === value)?.children ?? null;

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div
        class={cn(
          "flex border-b border-neutral-200 bg-neutral-50",
          listClassName
        )}
      >
        {tabs.map((tab) => {
          const isActive = value === tab.value;
          const tabDisabled = disabled && !isActive;
          return (
            <Button
              key={tab.value}
              variant="ghost"
              type="button"
              disabled={tabDisabled}
              onClick={() => {
                if (tabDisabled) return;
                onValueChange(tab.value);
              }}
              class={cn(
                "-mb-px rounded-none border-0 border-b-2 px-3 py-2 text-sm font-semibold transition-colors hover:bg-transparent",
                isActive
                  ? "border-blue-500 text-blue-600 hover:border-blue-500 active:border-blue-500"
                  : "border-transparent text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 active:border-neutral-300",
                tabDisabled && "opacity-50"
              )}
            >
              {tab.label}
              {tab.badge}
            </Button>
          );
        })}
      </div>
      <div class={cn("min-h-0 flex-1 overflow-hidden", contentClassName)}>
        {activeContent}
      </div>
    </div>
  );
}
