import { useState } from "preact/hooks";
import { Popover } from "src/components/common/Popover";
import { ProBadge } from "src/components/license/ProBadge";
import { useProGate } from "src/hooks/useProGate";
import {
  getAssistantMode,
  setAssistantMode,
  type AssistantMode,
} from "src/lib/ai-assistant/assistantMode";
import { cn } from "src/utils/cn";
import { CheckMarkIcon } from "../icons/CheckMark";

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

/**
 * Agent / Manual switch in the composer. Without Pro the assistant answers in manual mode,
 * and choosing Agent opens the upgrade dialog instead of switching.
 */
export function AssistantModePicker() {
  const { hasPro, requirePro } = useProGate();
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState<AssistantMode>(getAssistantMode);
  const active: AssistantMode = hasPro ? stored : "manual";
  const activeLabel = MODES.find((item) => item.mode === active)?.label;

  const choose = (mode: AssistantMode) => {
    setOpen(false);
    if (mode === "agent" && !requirePro("ai-agent")) return;
    setAssistantMode(mode);
    setStored(mode);
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
        <div class="w-72 overflow-hidden rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-2xl">
          <div class="px-2.5 pt-1 pb-1.5 text-xs font-medium text-neutral-400">
            Mode
          </div>
          {MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              class="flex w-full items-start gap-2 rounded-xl px-2.5 py-1.5 text-left hover:bg-neutral-100"
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
                <CheckMarkIcon className="mt-0.5 size-4 shrink-0 text-blue-600" />
              ) : null}
            </button>
          ))}
        </div>
      }
    >
      <button
        type="button"
        aria-label="Assistant mode"
        aria-haspopup="menu"
        class={cn(
          "inline-flex items-center gap-1 rounded-full px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100",
          open && "bg-neutral-100"
        )}
        onClick={() => setOpen((value) => !value)}
      >
        {activeLabel}
      </button>
    </Popover>
  );
}
