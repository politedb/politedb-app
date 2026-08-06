import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { AiAssistantPanel } from "src/components/ai-assistant/AiAssistantPanel";
import { SparklesIcon } from "src/components/icons";
import { useFloatingAssistantStore } from "src/stores/floatingAssistant";
import { cn } from "src/utils/cn";
import { Button } from "../common/Button";

export const OPEN_FLOATING_ASSISTANT_EVENT = "politedb-open-floating-assistant";

export function FloatingAssistantLauncher(props: {
  aiLocked?: boolean;
  onOpenLicense?: () => void;
}) {
  const { aiLocked = false, onOpenLicense } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const context = useFloatingAssistantStore((state) => state.context);

  const openAssistant = useCallback(() => {
    setOpen(true);
  }, []);

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
    const onOpen = () => openAssistant();
    window.addEventListener(OPEN_FLOATING_ASSISTANT_EVENT, onOpen);
    return () =>
      window.removeEventListener(OPEN_FLOATING_ASSISTANT_EVENT, onOpen);
  }, [openAssistant]);

  const chatSessionKey = context?.scopeKey ?? "global-ai-assistant";

  return (
    <div ref={rootRef} class="fixed right-4 bottom-4 z-50">
      {open ? (
        <div
          class={cn(
            "flex overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900",
            "h-[min(680px,calc(100vh-48px))] w-140",
            "max-sm:fixed max-sm:inset-3 max-sm:h-auto max-sm:w-auto"
          )}
          role="dialog"
          aria-label="AI assistant"
        >
          <div class="relative flex min-h-0 flex-1 flex-col">
            <div class="min-h-0 flex-1">
              {aiLocked ? (
                <div class="h-full bg-white dark:bg-slate-900" />
              ) : (
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
              )}
            </div>
            {aiLocked ? (
              <div class="absolute inset-0 z-20 flex items-center justify-center bg-white/78 px-6 backdrop-blur-sm dark:bg-slate-950/78">
                <div class="max-w-sm rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-xl dark:border-slate-700 dark:bg-slate-900">
                  <div class="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-300">
                    <SparklesIcon className="size-5" />
                  </div>
                  <div class="text-base font-semibold text-slate-900 dark:text-slate-100">
                    AI requires an active license
                  </div>
                  <p class="mt-2 text-sm leading-5 text-slate-500 dark:text-slate-400">
                    Activate your PoliteDB license to use the assistant.
                  </p>
                  <div class="mt-4 flex justify-center gap-2">
                    <Button
                      variant="default"
                      class="rounded-lg px-4 py-2 text-sm"
                      onClick={onOpenLicense}
                    >
                      Activate license
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!open ? (
        <Button
          variant="default"
          class="ml-auto rounded-full bg-blue-600 p-3 text-sm font-semibold shadow-xl transition-all hover:scale-105"
          title="Open AI assistant"
          aria-label="Open AI assistant"
          onClick={openAssistant}
        >
          <SparklesIcon className="size-5" />
        </Button>
      ) : null}
    </div>
  );
}
