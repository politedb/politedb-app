import { useEffect, useMemo, useState } from "preact/hooks";
import {
  formatShortcutLabel,
  keyboardEventToShortcut,
  SHORTCUT_DEFINITIONS,
  ShortcutActionId,
  useKeyboardShortcutsStore,
} from "src/stores/keyboardShortcuts";
import { Button } from "../common/Button";
import { cn } from "src/utils/cn";
import { SettingCard } from "./SettingCard";

export function KeyboardSettings(props: { active: boolean }) {
  const active = props.active ?? true;
  const shortcuts = useKeyboardShortcutsStore((s) => s.shortcuts);
  const setShortcut = useKeyboardShortcutsStore((s) => s.setShortcut);
  const resetShortcut = useKeyboardShortcutsStore((s) => s.resetShortcut);
  const resetAll = useKeyboardShortcutsStore((s) => s.resetAll);

  const [recordingId, setRecordingId] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState("");

  const usedBindings = useMemo(
    () =>
      new Map(Object.entries(shortcuts).map(([id, binding]) => [binding, id])),
    [shortcuts]
  );

  useEffect(() => {
    if (!active) {
      setRecordingId(null);
      setError("");
    }
  }, [active]);

  useEffect(() => {
    if (!active || !recordingId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingId(null);
        setError("");
        return;
      }

      const binding = keyboardEventToShortcut(event);
      if (!binding) {
        return;
      }

      const existing = usedBindings.get(binding);
      if (existing && existing !== recordingId) {
        const conflict = SHORTCUT_DEFINITIONS.find(
          (item) => item.id === existing
        );
        setError(
          `${formatShortcutLabel(binding)} is already used by "${conflict?.label ?? existing}".`
        );
        return;
      }

      setShortcut(recordingId, binding);
      setRecordingId(null);
      setError("");
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, recordingId, setShortcut, usedBindings]);

  return (
    <>
      <div
        class={cn(
          "rounded-xl border px-3 py-2 text-sm",
          error
            ? "border-amber-200 bg-amber-50 text-amber-700"
            : "border-blue-200 bg-blue-50 text-blue-700"
        )}
      >
        {error ||
          "Use at least one modifier key, like Cmd/Ctrl, Alt, or Shift."}
      </div>

      <SettingCard class="p-0!">
        {SHORTCUT_DEFINITIONS.map((item, index) => {
          const isRecording = recordingId === item.id;
          return (
            <div
              key={item.id}
              class={cn(
                "flex items-center justify-between gap-4 px-4 py-3",
                index > 0 ? "border-t border-slate-200" : ""
              )}
            >
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium text-slate-900">
                  {item.label}
                </div>
                <div class="mt-1 text-xs text-slate-500">
                  {item.description}
                </div>
              </div>

              <div class="flex shrink-0 items-center gap-2">
                <Button
                  variant={isRecording ? "default" : "shadow"}
                  className="min-w-32 justify-center rounded-xl"
                  onClick={() => {
                    setError("");
                    setRecordingId(isRecording ? null : item.id);
                  }}
                >
                  {isRecording
                    ? "Press keys..."
                    : formatShortcutLabel(shortcuts[item.id])}
                </Button>
                <Button
                  variant="outline"
                  className="rounded-xl"
                  onClick={() => {
                    setRecordingId(null);
                    setError("");
                    resetShortcut(item.id);
                  }}
                >
                  Reset
                </Button>
              </div>
            </div>
          );
        })}
      </SettingCard>
      <div class="flex flex-1 items-center justify-between gap-2">
        <div class="text-sm text-slate-600">
          Tip: press <span class="font-medium">Esc</span> to stop recording.
        </div>
        <div class="flex items-center gap-2">
          <Button variant="default" onClick={resetAll}>
            Reset all
          </Button>
        </div>
      </div>
    </>
  );
}
