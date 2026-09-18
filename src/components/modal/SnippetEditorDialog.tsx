import { useEffect, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import { Button } from "src/components/common/Button";
import type { SavedSnippet, SnippetScope } from "src/lib/snippets/types";
import { useSnippetsStore } from "src/stores/snippets";
import {
  formatShortcutLabel,
  keyboardEventToShortcut,
  normalizeShortcutBinding,
} from "src/stores/keyboardShortcuts";
import { cn } from "src/utils/cn";
import { XIcon } from "../icons";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save, before onClose. */
  onSaved?: () => void;
  profileId: string | null;
  initial?: Partial<SavedSnippet> & { sql?: string };
  title?: string;
};

export function SnippetEditorDialog({
  open,
  onClose,
  onSaved,
  profileId,
  initial,
  title,
}: Props) {
  const createSnippet = useSnippetsStore((s) => s.createSnippet);
  const updateSnippet = useSnippetsStore((s) => s.updateSnippet);

  const [name, setName] = useState("");
  const [sql, setSql] = useState("");
  const [scope, setScope] = useState<SnippetScope>("global");
  const [hotkey, setHotkey] = useState("");
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [hotkeyHint, setHotkeyHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setSql(initial?.sql ?? "");
    setScope(initial?.scope ?? (profileId ? "profile" : "global"));
    setHotkey(initial?.hotkey ?? "");
    setError(null);
    setRecordingHotkey(false);
    setHotkeyHint(null);
  }, [open, initial, profileId]);

  useEffect(() => {
    if (!open || !recordingHotkey) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingHotkey(false);
        setHotkeyHint(null);
        return;
      }

      const binding = keyboardEventToShortcut(event);
      if (!binding) {
        setHotkeyHint("Use at least one modifier (Cmd/Ctrl, Alt, or Shift).");
        return;
      }

      setHotkey(normalizeShortcutBinding(binding));
      setRecordingHotkey(false);
      setHotkeyHint(null);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, recordingHotkey]);

  const onSave = async () => {
    const nextName = name.trim();
    const nextSql = sql.trim();
    if (!nextName) {
      setError("Name is required.");
      return;
    }
    if (!nextSql) {
      setError("SQL is required.");
      return;
    }
    if (scope === "profile" && !profileId) {
      setError("No active connection profile for profile-scoped snippets.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (initial?.id) {
        await updateSnippet(initial.id, {
          name: nextName,
          sql: nextSql,
          scope,
          profileId: scope === "profile" ? profileId : null,
          folderId: initial?.folderId ?? null,
          hotkey: hotkey || null,
        });
      } else {
        await createSnippet({
          name: nextName,
          sql: nextSql,
          scope,
          profileId: scope === "profile" ? profileId : null,
          folderId: initial?.folderId ?? null,
          hotkey: hotkey || null,
        });
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg" showCloseButton>
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle>
          {title ?? (initial?.id ? "Edit snippet" : "Save snippet")}
        </DialogTitle>
      </DialogHeader>
      <DialogContent className="gap-3">
        <Input
          className="h-9"
          label="Name"
          value={name}
          onValueChange={setName}
          placeholder="e.g. Active users"
        />

        <div class="flex flex-col gap-1.5">
          <label class="text-sm font-medium">SQL</label>
          <textarea
            value={sql}
            onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)}
            rows={10}
            class={cn(
              "w-full rounded-lg border border-neutral-200 bg-white px-3 py-2",
              "font-mono text-sm text-neutral-800 outline-none",
              "focus:border-blue-400 focus:ring-2 focus:ring-blue-400/60"
            )}
            placeholder="SELECT ..."
          />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium">Scope</label>
            <select
              value={scope}
              onChange={(e) =>
                setScope((e.target as HTMLSelectElement).value as SnippetScope)
              }
              class="h-9 rounded-xl border border-neutral-200 bg-white px-2 text-sm"
            >
              <option value="global">Global</option>
              <option value="profile" disabled={!profileId}>
                This connection
              </option>
            </select>
          </div>

          <div class="flex flex-col gap-1">
            <Input
              label="Insert hotkey (optional)"
              value={
                recordingHotkey
                  ? "Press keys…"
                  : hotkey
                    ? formatShortcutLabel(hotkey)
                    : ""
              }
              placeholder="Click, then press keys to bind…"
              readOnly
              onFocus={() => {
                setRecordingHotkey(true);
                setHotkeyHint(null);
              }}
              onClick={() => {
                setRecordingHotkey(true);
                setHotkeyHint(null);
              }}
              className="h-9 w-full cursor-pointer"
              right={
                hotkey && !recordingHotkey ? (
                  <Button
                    variant="ghost"
                    class="p-1 text-xs"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setHotkey("");
                      setRecordingHotkey(false);
                      setHotkeyHint(null);
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null
              }
            />
            <p class="text-xs text-neutral-500">
              {hotkeyHint ??
                (recordingHotkey
                  ? "Recording… Esc to cancel. Needs a modifier key."
                  : "Needs Cmd/Ctrl, Alt, or Shift plus a key.")}
            </p>
          </div>
        </div>

        {error ? <p class="text-sm text-red-600">{error}</p> : null}
      </DialogContent>
      <DialogFooter className="border-t border-neutral-200">
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void onSave()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
