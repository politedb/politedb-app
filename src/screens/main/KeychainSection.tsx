import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import {
  secretsDelete,
  secretsGet,
  secretsList,
  secretsSet,
} from "src/lib/tauri";
import { KeychainCard } from "./KeychainCard";
import type { ViewMode } from "src/types";
import { cn } from "src/utils/cn";

function isTauriRuntime() {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return "Unknown error";
}

function EmptyState(props: { hasSearch: boolean }) {
  const { hasSearch } = props;

  return (
    <div class="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
      <div class="text-sm font-semibold text-slate-900">
        {hasSearch ? "No matching keys" : "No keys yet"}
      </div>
      <div class="mt-1 text-sm text-slate-500">Try a different keyword.</div>
    </div>
  );
}

export function KeychainSection(props: {
  searchQuery: string;
  viewMode: ViewMode;
  newSignal: number;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
}) {
  const { searchQuery, viewMode, newSignal, editorOpen, onEditorOpenChange } =
    props;
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [resolvedValue, setResolvedValue] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tauriReady = useMemo(() => isTauriRuntime(), []);

  const handleSet = async () => {
    if (!key.trim()) {
      setError("Key is required.");
      return;
    }
    if (!value) {
      setError("Value is required.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const keyToSave = key.trim();
      await secretsSet(keyToSave, value);
      setResolvedValue(value);
      setMessage("Saved to keychain.");
      setKeys((prev) =>
        prev.includes(keyToSave) ? prev : [...prev, keyToSave].sort()
      );
      setSelectedKey(keyToSave);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleGet = async () => {
    if (!key.trim()) {
      setError("Key is required.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const keyToLoad = key.trim();
      const next = await secretsGet(keyToLoad);
      setResolvedValue(next);
      setMessage("Loaded from keychain.");
      setSelectedKey(keyToLoad);
    } catch (e) {
      setError(getErrorMessage(e));
      setResolvedValue("");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteByKey = async (targetKey: string) => {
    if (!targetKey.trim()) {
      setError("Key is required.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const keyToDelete = targetKey.trim();
      await secretsDelete(keyToDelete);
      setResolvedValue("");
      setMessage("Deleted from keychain.");
      setKeys((prev) => prev.filter((k) => k !== keyToDelete));
      if (selectedKey === keyToDelete) {
        setSelectedKey(null);
      }
      if (key.trim() === keyToDelete) {
        setKey("");
      }
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    await handleDeleteByKey(key);
  };

  const handleImportKeys = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const imported = await secretsList();
      setKeys(imported);
      setMessage(`Imported ${imported.length} key(s).`);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUseImportedKey = async (nextKey: string) => {
    setSelectedKey(nextKey);
    setKey(nextKey);
    setValue("");
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await secretsGet(nextKey);
      setResolvedValue(next);
      setMessage(`Loaded key '${nextKey}'.`);
      onEditorOpenChange(true);
    } catch (e) {
      setError(getErrorMessage(e));
      setResolvedValue("");
    } finally {
      setBusy(false);
    }
  };

  const handleCloseEditor = () => {
    onEditorOpenChange(false);
    setSelectedKey(null);
    setKey("");
    setValue("");
    setResolvedValue("");
    setMessage(null);
    setError(null);
  };

  useEffect(() => {
    if (!tauriReady) return;
    void handleImportKeys();
  }, [tauriReady]);

  useEffect(() => {
    setSelectedKey(null);
    setKey("");
    setValue("");
    setResolvedValue("");
    setMessage(null);
    setError(null);
  }, [newSignal]);

  const canSubmit = tauriReady && !busy;
  const filteredKeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return keys;
    return keys.filter((k) => k.toLowerCase().includes(q));
  }, [keys, searchQuery]);

  return (
    <div class="h-full w-full bg-neutral-100">
      <div class="mx-auto w-full max-w-400 px-6 py-5">
        {!tauriReady && (
          <div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Keychain is available only in the desktop app runtime (Tauri).
          </div>
        )}

        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold tracking-wide text-slate-800">
            Keychain ({filteredKeys.length})
          </h2>
        </div>

        {filteredKeys.length === 0 && (
          <EmptyState hasSearch={!!searchQuery.trim()} />
        )}

        <div
          class={
            viewMode === "grid"
              ? "grid grid-cols-1 gap-4 md:grid-cols-2"
              : "space-y-2"
          }
        >
          {filteredKeys.map((k) => {
            return (
              <KeychainCard
                key={k}
                keyName={k}
                selected={selectedKey === k}
                disabled={!canSubmit}
                onSelect={() => setSelectedKey(k)}
                onOpen={() => void handleUseImportedKey(k)}
                onCopy={() => void navigator.clipboard.writeText(k)}
                onDelete={() => void handleDeleteByKey(k)}
              />
            );
          })}
        </div>
      </div>

      <Dialog
        open={editorOpen}
        onClose={handleCloseEditor}
        size="md"
        closeOnOutsideClick
      >
        <DialogHeader>
          <DialogTitle>Secret Editor</DialogTitle>
        </DialogHeader>
        <DialogContent className="gap-3">
          <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div>
              <div class="mb-1 text-xs font-medium text-slate-700">Key</div>
              <Input
                value={key}
                onValueChange={setKey}
                placeholder="example: profile:abc:postgres:password"
                className="rounded-md border border-slate-300 bg-white"
              />
            </div>
            <div>
              <div class="mb-1 text-xs font-medium text-slate-700">Value</div>
              <Input
                value={value}
                onValueChange={setValue}
                placeholder="Secret value"
                className="rounded-md border border-slate-300 bg-white"
                type="password"
              />
            </div>
          </div>

          <div>
            <div class="mb-1 text-xs font-medium text-slate-700">
              Last loaded value
            </div>
            <Input
              value={resolvedValue}
              readOnly
              className="rounded-md border border-slate-300 bg-slate-50 font-mono"
              placeholder="No value loaded"
            />
          </div>

          {(message || error) && (
            <div
              class={cn(
                "rounded-md border px-3 py-2 text-xs",
                error
                  ? "border-rose-200 bg-rose-50 text-rose-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              )}
            >
              {error ?? message}
            </div>
          )}
        </DialogContent>
        <DialogFooter className="justify-between">
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              className="py-2"
              onClick={() => void navigator.clipboard.writeText(key)}
              disabled={!key}
            >
              Copy key
            </Button>
            <Button
              variant="outline"
              className="py-2"
              onClick={() => void navigator.clipboard.writeText(resolvedValue)}
              disabled={!resolvedValue}
            >
              Copy value
            </Button>
          </div>

          <div class="flex items-center gap-2">
            <Button
              variant="default"
              className="py-2"
              onClick={() => void handleSet()}
              loading={busy}
              disabled={!canSubmit}
            >
              Save
            </Button>
            <Button
              variant="shadow"
              className="py-2"
              onClick={() => void handleGet()}
              loading={busy}
              disabled={!canSubmit}
            >
              Get
            </Button>
            <Button
              variant="destructive"
              className="py-2"
              onClick={() => void handleDelete()}
              loading={busy}
              disabled={!canSubmit}
            >
              Delete
            </Button>
          </div>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
