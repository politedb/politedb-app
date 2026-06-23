import { useEffect, useRef, useState } from "preact/hooks";
import { AiAssistantPanel } from "src/components/ai-assistant/AiAssistantPanel";
import { SparklesIcon } from "src/components/icons";
import { useFloatingAssistantStore } from "src/stores/floatingAssistant";
import { cn } from "src/utils/cn";
import { Button } from "../common/Button";

export const OPEN_FLOATING_ASSISTANT_EVENT = "politedb-open-floating-assistant";

export function FloatingAssistantLauncher(props: { disabled?: boolean }) {
  const { disabled = false } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const context = useFloatingAssistantStore((state) => state.context);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || rootRef.current?.contains(target)) return;
      if (
        target.closest("[data-ai-assistant-popover='true']") ||
        target.closest(".politedb-popover-container")
      ) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_FLOATING_ASSISTANT_EVENT, onOpen);
    return () =>
      window.removeEventListener(OPEN_FLOATING_ASSISTANT_EVENT, onOpen);
  }, []);

  if (disabled) return null;

  const chatSessionKey = context?.scopeKey ?? "global-ai-assistant";

  return (
    <div ref={rootRef} class="fixed right-4 bottom-4 z-50">
      {open ? (
        <div
          class={cn(
            "flex overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl",
            "h-[min(680px,calc(100vh-48px))] w-[560px]",
            "max-sm:fixed max-sm:inset-3 max-sm:h-auto max-sm:w-auto"
          )}
          role="dialog"
          aria-label="AI assistant"
        >
          <div class="flex min-h-0 flex-1 flex-col">
            <div class="min-h-0 flex-1">
              <AiAssistantPanel
                presentation="floating"
                onClose={() => setOpen(false)}
                chatSessionKey={chatSessionKey}
                engine={context?.engine ?? "postgres"}
                runtimeConnectionId={context?.runtimeConnectionId}
                activeSchema={context?.activeSchema}
                tables={context?.tables ?? []}
                columnsByTable={context?.columnsByTable}
                currentSql={context?.currentSql}
                onInsertSql={context?.onInsertSql}
              />
            </div>
          </div>
        </div>
      ) : null}

      {!open ? (
        <Button
          variant="default"
          class="ml-auto rounded-full bg-blue-600 p-3 text-sm font-semibold shadow-xl transition-all hover:scale-105"
          title="Open AI assistant"
          aria-label="Open AI assistant"
          onClick={() => setOpen(true)}
        >
          <SparklesIcon className="size-5" />
        </Button>
      ) : null}
    </div>
  );
}
