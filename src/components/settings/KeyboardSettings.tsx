import { useEffect, useMemo, useState } from "preact/hooks";
import {
  formatShortcutLabel,
  isDefaultShortcut,
  keyboardEventToShortcut,
  reservedShortcutOwner,
  SHORTCUT_DEFINITIONS,
  ShortcutActionId,
  useKeyboardShortcutsStore,
} from "src/stores/keyboardShortcuts";
import { Button } from "../common/Button";
import { cn } from "src/utils/cn";
import { SettingCard } from "./SettingCard";
import { FieldRow } from "./FieldRow";
import { confirmDialog } from "src/lib/system-dialog";
import { EditIcon } from "src/components/icons";

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

      const reserved = reservedShortcutOwner(binding);
      if (reserved) {
        setError(
          `${formatShortcutLabel(binding)} opens ${reserved} and cannot be used here.`
        );
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

  const modifiedCount = SHORTCUT_DEFINITIONS.filter(
    (item) => !isDefaultShortcut(item.id, shortcuts[item.id])
  ).length;

  async function handleResetAll() {
    const ok = await confirmDialog(
      `Reset ${modifiedCount} changed shortcut${modifiedCount === 1 ? "" : "s"} to the defaults?`,
      {
        title: "Reset shortcuts",
        kind: "warning",
        okLabel: "Reset",
        cancelLabel: "Cancel",
      }
    );
    if (!ok) return;
    setRecordingId(null);
    setError("");
    resetAll();
  }

  return (
    <>
      {/* The rules show while recording; only a refused key gets a banner. */}
      {error ? (
        <div
          role="alert"
          class="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700"
        >
          {error}
        </div>
      ) : null}

      <SettingCard class="[&>div>div]:last:pb-4">
        {SHORTCUT_DEFINITIONS.map((item) => {
          const isRecording = recordingId === item.id;
          const modified = !isDefaultShortcut(item.id, shortcuts[item.id]);
          return (
            <FieldRow
              key={item.id}
              label={item.label}
              description={item.description}
            >
              <div class="flex shrink-0 items-center gap-2">
                {/* Only a changed shortcut can be reset; the slot keeps
                    the column aligned. */}
                <Button
                  variant="outline"
                  className={cn("rounded-xl", !modified && "invisible")}
                  aria-hidden={!modified}
                  tabIndex={modified ? 0 : -1}
                  disabled={!modified}
                  aria-label={`Reset ${item.label}`}
                  onClick={() => {
                    setRecordingId(null);
                    setError("");
                    resetShortcut(item.id);
                  }}
                >
                  Reset
                </Button>
                <Button
                  variant={isRecording ? "default" : "shadow"}
                  className="group relative min-w-32 justify-center rounded-xl"
                  title={isRecording ? undefined : "Click to change"}
                  aria-label={
                    isRecording
                      ? `Recording a shortcut for ${item.label}`
                      : `Change shortcut for ${item.label}, currently ${formatShortcutLabel(shortcuts[item.id])}`
                  }
                  onClick={() => {
                    setError("");
                    setRecordingId(isRecording ? null : item.id);
                  }}
                >
                  {isRecording
                    ? "Press keys..."
                    : formatShortcutLabel(shortcuts[item.id])}
                  {isRecording ? null : (
                    <EditIcon
                      aria-hidden
                      className="absolute right-2.5 size-3.5 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  )}
                </Button>
              </div>
            </FieldRow>
          );
        })}
      </SettingCard>
      <div class="flex flex-1 items-start justify-between gap-2">
        <div class="text-xs text-blue-700 dark:text-blue-300">
          {recordingId &&
            " Press keys with Cmd/Ctrl, Alt or Shift. Esc stops recording."}
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={modifiedCount === 0}
            onClick={() => void handleResetAll()}
          >
            Reset all
          </Button>
        </div>
      </div>
    </>
  );
}
