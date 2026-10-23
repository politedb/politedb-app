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
import { pickHostDbUser } from "src/lib/connection/connection";
import { profileConnectionHost } from "src/utils/connectionLog";
import { Button } from "../common/Button";
import {
  clampLauncherPosition,
  loadLauncherPosition,
  saveLauncherPosition,
  type LauncherPosition,
} from "src/lib/ai-assistant/launcherPosition";

/** Pointer travel that turns a press on the button into a drag. */
const DRAG_THRESHOLD = 4;
/** Alt+arrow moves the button this far. */
const KEYBOARD_STEP = 24;

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
  // The button can be dragged anywhere so it never covers what the user needs
  // to see; the chosen spot is remembered on this device.
  const [position, setPosition] = useState<LauncherPosition>(() =>
    loadLauncherPosition()
  );
  const suppressClick = useRef(false);

  const fit = useCallback(
    (next: LauncherPosition) => {
      // While closed the root holds only the button.
      const size = (!open && rootRef.current?.offsetWidth) || 40;
      return clampLauncherPosition(
        next,
        { width: window.innerWidth, height: window.innerHeight },
        size
      );
    },
    [open]
  );

  useEffect(() => {
    const onResize = () => setPosition((current) => fit(current));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fit]);

  // Latest values for the window listeners of a drag in progress.
  const positionRef = useRef(position);
  positionRef.current = position;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const stopDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDragRef.current?.(), []);

  const onPointerDown = (event: PointerEvent) => {
    // Main button only; a second finger never starts another drag.
    if (event.button !== 0) return;
    if (event.pointerType === "touch" && !event.isPrimary) return;
    stopDragRef.current?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = positionRef.current;
    let moved = false;
    let last = start;

    // Listen on the window, so moving off the button (or a browser that
    // refuses pointer capture) never strands the drag.
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      // A mouse released outside the window: end without moving further.
      if (e.pointerType === "mouse" && e.buttons === 0) return finish(e);
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      last = fitRef.current({
        right: start.right - dx,
        bottom: start.bottom - dy,
      });
      setPosition(last);
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      stop();
      if (!moved) return;
      saveLauncherPosition(last);
      // The click that ends this drag must not open the assistant; a cancelled
      // pointer gets no click, so never leave the flag armed past this event.
      if (e.type === "pointerup") {
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      stopDragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    stopDragRef.current = stop;
  };

  const onLauncherKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey) return;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [KEYBOARD_STEP, 0],
      ArrowRight: [-KEYBOARD_STEP, 0],
      ArrowUp: [0, KEYBOARD_STEP],
      ArrowDown: [0, -KEYBOARD_STEP],
    };
    const step = delta[event.key];
    if (!step) return;
    event.preventDefault();
    const next = fit({
      right: position.right + step[0],
      bottom: position.bottom + step[1],
    });
    setPosition(next);
    saveLauncherPosition(next);
  };
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
    <div
      ref={rootRef}
      class={cn("fixed z-50", open && "right-6 bottom-9")}
      // The open panel keeps its usual corner; the closed button sits where the
      // user dragged it.
      style={
        open ? undefined : { right: position.right, bottom: position.bottom }
      }
    >
      {open ? (
        <div
          class={cn(
            "flex overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl",
            "h-[min(660px,calc(100vh-48px))] w-130",
            "max-sm:fixed max-sm:inset-3 max-sm:h-auto max-sm:w-auto"
          )}
          role="dialog"
          aria-label="AI assistant"
        >
          <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
            <AiAssistantPanel
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
          class="ml-auto cursor-grab touch-none rounded-full p-2.5 text-sm font-semibold shadow-xl transition-transform hover:scale-105 active:cursor-grabbing"
          title="Open AI assistant (drag to move)"
          aria-label="Open AI assistant"
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
          onPointerDown={onPointerDown}
          onKeyDown={onLauncherKeyDown}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            openAssistant();
          }}
        >
          <SparklesIcon className="size-5" />
        </Button>
      ) : null}
    </div>
  );
}
