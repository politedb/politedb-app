import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { SparklesIcon } from "src/components/icons";
import { createRetryableLazy } from "src/components/common/RetryableLazy";
import { useFloatingAssistantStore } from "src/stores/floatingAssistant";
import { useProfileStore } from "src/stores/profile";
import { useScreenStore } from "src/stores/screen";
import { cn } from "src/utils/cn";
import { pickHostDbUser } from "src/utils/connection";
import { profileConnectionHost } from "src/utils/connectionLog";
import { Button } from "../common/Button";

const loadAiAssistantPanel = () =>
  import("src/components/ai-assistant/AiAssistantPanel").then((module) => ({
    default: module.AiAssistantPanel,
  }));

const AiAssistantPanel = createRetryableLazy(loadAiAssistantPanel, {
  label: "AI assistant",
});

export const OPEN_FLOATING_ASSISTANT_EVENT = "politedb-open-floating-assistant";
export const FLOATING_ASSISTANT_CHAT_SESSION_KEY = "global-ai-assistant";

export function normalizeSavedConnectionTags(tags: unknown[] = [], label = "") {
  const normalized = new Set<string>();
  for (const tag of tags) {
    const trimmed = String(tag ?? "").trim();
    if (!trimmed) continue;
    normalized.add(trimmed);
    if (trimmed.toLowerCase() === "production") normalized.add("prod");
  }
  if (/\bprod(uction)?\b/i.test(label)) normalized.add("prod");
  return Array.from(normalized);
}

export function FloatingAssistantLauncher() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeProfileScreen = useScreenStore(
    (state) => state.activeProfileScreen
  );
  const storedContext = useFloatingAssistantStore((state) => state.context);
  const profiles = useProfileStore((state) => state.profiles);
  const savedConnections = useMemo(
    () =>
      profiles.map((profile) => {
        const { user } = pickHostDbUser(profile);
        return {
          id: profile.id,
          label: profile.label,
          engine: profile.engine,
          tags: normalizeSavedConnectionTags(
            [...(profile.tags ?? []), ...(profile.input?.tags ?? [])],
            profile.label
          ),
          target: profileConnectionHost(profile),
          user: user || undefined,
        };
      }),
    [profiles]
  );
  const context =
    activeProfileScreen !== "main" &&
    storedContext?.scopeKey === activeProfileScreen
      ? storedContext
      : null;

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

  const chatSessionKey =
    context?.scopeKey ?? FLOATING_ASSISTANT_CHAT_SESSION_KEY;

  return (
    <div ref={rootRef} class="fixed right-6 bottom-9 z-50">
      {open ? (
        <div
          class={cn(
            "flex overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900",
            "h-[min(660px,calc(100vh-48px))] w-130",
            "max-sm:fixed max-sm:inset-3 max-sm:h-auto max-sm:w-auto"
          )}
          role="dialog"
          aria-label="AI assistant"
        >
          <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
            <AiAssistantPanel
              presentation="floating"
              onClose={() => setOpen(false)}
              chatSessionKey={chatSessionKey}
              engine={context?.engine ?? "postgres"}
              runtimeConnectionId={context?.runtimeConnectionId}
              activeSchema={context?.activeSchema}
              activeTable={context?.activeTable}
              tables={context?.tables ?? []}
              columnsByTable={context?.columnsByTable}
              columnDetailsByTable={context?.columnDetailsByTable}
              currentSql={context?.currentSql}
              querySafetyMode={context?.querySafetyMode}
              savedConnections={savedConnections}
              onInsertSql={context?.onInsertSql}
            />
          </div>
        </div>
      ) : null}

      {!open ? (
        <Button
          variant="default"
          class="ml-auto rounded-full p-2.5 text-sm font-semibold shadow-xl transition-all hover:scale-105"
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
