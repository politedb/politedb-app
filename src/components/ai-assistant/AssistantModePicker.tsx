import { useEffect, useRef, useState } from "preact/hooks";
import { Popover } from "src/components/common/Popover";
import { ProBadge } from "src/components/license/ProBadge";
import { useProGate } from "src/hooks/useProGate";
import {
  setAssistantMode,
  type AssistantMode,
} from "src/lib/ai-assistant/assistantMode";
import { cn } from "src/utils/cn";
import { CheckMarkIcon } from "../icons/CheckMark";
import { useAssistantMode } from "./useAssistantMode";

const MODES: {
  mode: AssistantMode;
  label: string;
  description: string;
  pro?: boolean;
}[] = [
  {
    mode: "agent",
    label: "Agent",
    description: "Looks up your schema and runs read-only queries",
    pro: true,
  },
  {
    mode: "manual",
    label: "Manual",
    description: "Answers from the chat and the context you attach",
  },
];

const MENU_ID = "assistant-mode-menu";

/**
 * Agent / Manual switch in the composer. Without Pro the assistant answers in manual mode,
 * and choosing Agent opens the upgrade dialog instead of switching.
 */
export function AssistantModePicker() {
  const { hasPro, requirePro } = useProGate();
  const stored = useAssistantMode();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active: AssistantMode = hasPro ? stored : "manual";
  const activeLabel = MODES.find((item) => item.mode === active)?.label;

  // Opening moves focus to the selected mode, like a native menu. The popover mounts
  // its content a render later, so this runs both when the menu element attaches and
  // when it reopens while still mounted (during its close transition).
  const focusSelected = () => {
    const index = MODES.findIndex((item) => item.mode === active);
    itemRefs.current[Math.max(index, 0)]?.focus();
  };
  const menuRef = (element: HTMLDivElement | null) => {
    if (element && open) focusSelected();
  };
  useEffect(() => {
    if (open) focusSelected();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (mode: AssistantMode) => {
    closeMenu();
    if (mode === "agent" && !requirePro("ai-agent")) return;
    setAssistantMode(mode);
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const items = itemRefs.current.filter(Boolean) as HTMLButtonElement[];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      positions={["top"]}
      align="start"
      padding={12}
      showArrow={false}
      contentClassName="rounded-2xl"
      content={
        <div
          ref={menuRef}
          id={MENU_ID}
          role="menu"
          aria-label="Assistant mode"
          class="w-72 overflow-hidden rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-2xl"
          onKeyDown={onMenuKeyDown}
        >
          <div
            class="px-2.5 pt-1 pb-1.5 text-xs font-medium text-neutral-400"
            aria-hidden="true"
          >
            Mode
          </div>
          {MODES.map((item, index) => (
            <button
              key={item.mode}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={item.mode === active}
              class={cn(
                "flex w-full items-start gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                "outline-none hover:bg-neutral-100 focus-visible:bg-neutral-100"
              )}
              onClick={() => choose(item.mode)}
            >
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5 text-sm font-medium text-neutral-900">
                  {item.label}
                  {item.pro ? <ProBadge /> : null}
                </span>
                <span class="block text-xs text-neutral-500">
                  {item.description}
                </span>
              </span>
              {item.mode === active ? (
                <CheckMarkIcon
                  className="mt-0.5 size-4 shrink-0 text-blue-600"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          ))}
        </div>
      }
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Assistant mode: ${activeLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
        class={cn(
          "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold",
          "text-neutral-600 transition-colors hover:bg-neutral-100",
          open && "bg-neutral-100"
        )}
        onClick={() => setOpen((value) => !value)}
      >
        {activeLabel}
      </button>
    </Popover>
  );
}
