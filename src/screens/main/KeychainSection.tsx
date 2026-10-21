import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { aiProviderList } from "src/lib/tauri/ai";
import { profileList } from "src/lib/tauri/profile";
import type { ConnectionProfile } from "src/lib/tauri/types";
import {
  groupKeychainKeys,
  keychainDisplay,
  sortKeychainKeys,
} from "src/lib/keychain/display";
import { confirmDialog } from "src/lib/system-dialog";
import {
  deleteUnusedKeys,
  describeUnusedKeyCleanup,
} from "src/lib/keychain/cleanup";
import type { AiProviderConfig } from "src/types";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import type { KeychainSortMode, ViewMode } from "src/types";
import { cn } from "src/utils/cn";
import { CopyIcon, KeyIcon, LockIcon, XIcon } from "src/components/icons";

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
    <div>
      <div class="mb-3 flex items-center justify-between gap-8">
        <h3 class="flex items-center gap-2 text-sm font-semibold tracking-wide text-slate-800">
          <KeyIcon className="size-4 text-slate-500" />
          Credentials (0)
        </h3>

        <div class="flex items-center gap-1">
          <LockIcon className="size-4 text-green-600" />
          <span class="text-sm font-medium text-slate-500">
            Stored securely in macOS keychain
          </span>
        </div>
      </div>

      <div class="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
        <div class="text-sm font-semibold text-slate-900">
          {hasSearch ? "No matching keys" : "No keys yet"}
        </div>
        <div class="mt-1 text-sm text-slate-500">Try a different keyword.</div>
      </div>
    </div>
  );
}

export function KeychainSection(props: {
  searchQuery: string;
  viewMode: ViewMode;
  sortMode: KeychainSortMode;
  newSignal: number;
  editorOpen: boolean;
  onEditorOpenChange: (open: boolean) => void;
}) {
  const {
    searchQuery,
    viewMode,
    sortMode,
    newSignal,
    editorOpen,
    onEditorOpenChange,
  } = props;
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [resolvedValue, setResolvedValue] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  // AI providers and connections give their keys readable names.
  // null until loaded, or when loading failed: then no key is called unused.
  const [aiProviders, setAiProviders] = useState<AiProviderConfig[] | null>(
    null
  );
  const [profiles, setProfiles] = useState<ConnectionProfile[] | null>(null);
  // Per source, so a later successful load clears its own warning.
  const [providersFailed, setProvidersFailed] = useState(false);
  const [profilesFailed, setProfilesFailed] = useState(false);
  // One keychain operation at a time: a finished read must never re-enable
  // actions while a delete or a cleanup is still running.
  const lockRef = useRef(false);
  const acquire = () => {
    if (lockRef.current) return false;
    lockRef.current = true;
    setBusy(true);
    return true;
  };
  const release = () => {
    lockRef.current = false;
    setBusy(false);
  };
  const [cleaning, setCleaning] = useState(false);
  // Result of a bulk cleanup, shown on the page (the editor is usually closed).
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
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

    if (!acquire()) return;
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
      release();
    }
  };

  const handleGet = async () => {
    if (!key.trim()) {
      setError("Key is required.");
      return;
    }

    if (!acquire()) return;
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
      release();
    }
  };

  const handleDeleteByKey = async (targetKey: string) => {
    if (!targetKey.trim()) {
      setError("Key is required.");
      return;
    }

    if (!acquire()) return;
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
      release();
    }
  };

  const handleDelete = async () => {
    await handleDeleteByKey(key);
  };

  const handleImportKeys = async () => {
    if (!acquire()) return;
    setError(null);
    setMessage(null);
    try {
      const imported = await secretsList();
      setKeys(imported);
      setMessage(`Imported ${imported.length} key(s).`);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      release();
    }
  };

  const handleUseImportedKey = async (nextKey: string) => {
    if (!acquire()) return;
    setSelectedKey(nextKey);
    setKey(nextKey);
    setValue("");
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
      release();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tauriReady]);

  useEffect(() => {
    if (!tauriReady) return;
    const load = () =>
      aiProviderList()
        .then((list) => {
          setAiProviders(list);
          setProvidersFailed(false);
        })
        .catch(() => {
          setAiProviders(null);
          setProvidersFailed(true);
        });
    void load();
    void profileList()
      .then((list) => {
        setProfiles(list);
        setProfilesFailed(false);
      })
      .catch(() => {
        setProfiles(null);
        setProfilesFailed(true);
      });
    window.addEventListener("politedb-ai-providers-changed", load);
    return () =>
      window.removeEventListener("politedb-ai-providers-changed", load);
  }, [tauriReady]);

  const displays = useMemo(
    () =>
      new Map(
        keys.map((k) => [
          k,
          keychainDisplay(k, {
            aiProviders: aiProviders ?? undefined,
            profiles: profiles ?? undefined,
          }),
        ])
      ),
    [keys, aiProviders, profiles]
  );

  useEffect(() => {
    setSelectedKey(null);
    setKey("");
    setValue("");
    setResolvedValue("");
    setMessage(null);
    setError(null);
  }, [newSignal]);

  const canSubmit = tauriReady && !busy && !cleaning;
  const filteredKeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matched = !q
      ? keys
      : keys.filter((k) => {
          const d = displays.get(k);
          return [k, d?.title ?? "", d?.badge ?? "", d?.detail ?? ""].some(
            (text) => text.toLowerCase().includes(q)
          );
        });
    return sortKeychainKeys(matched, displays, sortMode);
  }, [keys, displays, searchQuery, sortMode]);

  const groups = useMemo(
    () => groupKeychainKeys(filteredKeys, displays),
    [filteredKeys, displays]
  );

  // Keys no connection or AI provider uses: delete them in one go.
  const handleDeleteUnused = async (unusedKeys: string[]) => {
    if (!unusedKeys.length || lockRef.current) return;
    const ok = await confirmDialog(
      `Delete ${unusedKeys.length} unused key${unusedKeys.length === 1 ? "" : "s"} from the keychain? No connection or AI provider uses them.`,
      {
        title: "Delete unused keys",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      }
    );
    if (!ok || !acquire()) return;

    setCleaning(true);
    setNotice(null);
    try {
      const result = await deleteUnusedKeys(unusedKeys, {
        // Checked again right before deleting: owners may have loaded or
        // changed while the confirmation was open.
        loadOwners: async () => {
          const [freshProviders, freshProfiles] = await Promise.all([
            aiProviderList(),
            profileList(),
          ]);
          setAiProviders(freshProviders);
          setProfiles(freshProfiles);
          setProvidersFailed(false);
          setProfilesFailed(false);
          return { aiProviders: freshProviders, profiles: freshProfiles };
        },
        deleteKey: secretsDelete,
      });
      const deleted = new Set(result.deleted);
      if (selectedKey && deleted.has(selectedKey)) setSelectedKey(null);
      if (deleted.has(key.trim())) {
        setKey("");
        setResolvedValue("");
      }
      let text = describeUnusedKeyCleanup(result);
      // A rejected delete may still have removed some copies, so show what the
      // keychain holds now rather than assume.
      try {
        setKeys(await secretsList());
      } catch (e) {
        setKeys((prev) => prev.filter((k) => !deleted.has(k)));
        text += ` The key list could not be refreshed: ${getErrorMessage(e)}`;
      }
      setNotice({
        kind: result.failed.length ? "error" : "success",
        text,
      });
    } catch (e) {
      setNotice({
        kind: "error",
        text: `Could not check which keys are in use, so nothing was deleted: ${getErrorMessage(e)}`,
      });
    } finally {
      setCleaning(false);
      release();
    }
  };

  return (
    <div class="h-full w-full bg-slate-50">
      <div class="mx-auto w-full max-w-400 px-6 py-5">
        {!tauriReady && (
          <div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Keychain is available only in the desktop app runtime (Tauri).
          </div>
        )}

        {providersFailed || profilesFailed ? (
          <div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Could not load your connections or AI providers, so unused keys
            cannot be identified.
          </div>
        ) : null}

        {notice ? (
          <div
            role="status"
            class={cn(
              "mb-4 rounded-xl border px-4 py-3 text-sm",
              notice.kind === "error"
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            )}
          >
            <div class="flex items-start justify-between gap-3">
              <span>{notice.text}</span>
              <button
                type="button"
                class="shrink-0 leading-0 opacity-70 hover:opacity-100"
                aria-label="Dismiss"
                onClick={() => setNotice(null)}
              >
                <XIcon className="size-4" />
              </button>
            </div>
          </div>
        ) : null}

        {filteredKeys.length === 0 && (
          <EmptyState hasSearch={!!searchQuery.trim()} />
        )}

        <div class="space-y-6">
          {groups.map((group) => {
            const isUnused = group.id === "unused";
            return (
              <section key={group.id} aria-label={group.label}>
                <div class="mb-3 flex items-center justify-between gap-4">
                  <div class="flex flex-1 items-center justify-between gap-8">
                    <h2
                      class={cn(
                        "flex items-center gap-2 text-sm font-semibold tracking-wide",
                        isUnused
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-slate-800"
                      )}
                    >
                      <KeyIcon className="size-4 text-slate-500" />
                      {group.label} ({group.keys.length})
                    </h2>
                    <div class="flex items-center gap-1">
                      <LockIcon className="size-4 text-green-600" />
                      <span class="text-sm font-medium text-slate-500">
                        Stored securely in macOS keychain
                      </span>
                    </div>
                  </div>

                  {isUnused ? (
                    <Button
                      variant="outline"
                      className="h-6 border-rose-300 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                      disabled={!canSubmit}
                      loading={cleaning}
                      onClick={() => void handleDeleteUnused(group.keys)}
                    >
                      Delete unused
                    </Button>
                  ) : null}
                </div>
                {isUnused ? (
                  <p class="mb-2 text-xs text-slate-500">
                    No connection or AI provider uses these keys any more.
                  </p>
                ) : null}
                <div
                  class={
                    viewMode === "grid"
                      ? "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
                      : "space-y-2"
                  }
                >
                  {group.keys.map((k) => (
                    <KeychainCard
                      key={k}
                      keyName={k}
                      display={displays.get(k) ?? keychainDisplay(k)}
                      selected={selectedKey === k}
                      disabled={!canSubmit}
                      onSelect={() => setSelectedKey(k)}
                      onOpen={() => void handleUseImportedKey(k)}
                      onCopy={() => void navigator.clipboard.writeText(k)}
                      onDelete={() => void handleDeleteByKey(k)}
                    />
                  ))}
                </div>
              </section>
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
        <DialogHeader className="border-b border-neutral-200">
          <DialogTitle className="flex items-center gap-2">
            <KeyIcon className="size-4 text-neutral-600" />
            Secret Editor
          </DialogTitle>
          <DialogDescription>
            Configure the key and value for your secret.
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="gap-2">
          <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Input
              label="Key"
              value={key}
              onValueChange={setKey}
              placeholder="Secret key"
              className="h-9 rounded-md border border-slate-300 bg-white"
              right={
                <CopyIcon
                  onClick={() => void navigator.clipboard.writeText(key)}
                  className="size-4"
                />
              }
            />

            <Input
              label="Value"
              value={value}
              onValueChange={setValue}
              placeholder="Secret value"
              className="h-9 rounded-md border border-slate-300 bg-white"
              type="password"
            />
          </div>

          <Input
            label="Last loaded value"
            value={new Array(48).fill("*").join("")}
            readOnly
            className="h-9 rounded-md border border-slate-300 bg-slate-50 align-middle"
            style={{ paddingTop: "8px", paddingBottom: "6px" }}
            placeholder="No value loaded"
            right={
              <CopyIcon
                onClick={() =>
                  void navigator.clipboard.writeText(resolvedValue)
                }
                className="size-4"
              />
            }
          />

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
              variant="shadow"
              className="py-1"
              onClick={() => void handleGet()}
              loading={busy}
              disabled={!canSubmit}
            >
              Load key
            </Button>
          </div>

          <div class="flex items-center gap-2">
            <Button
              variant="default"
              className="py-1"
              onClick={() => void handleSet()}
              loading={busy}
              disabled={!canSubmit}
            >
              Save
            </Button>
            <Button
              variant="outline"
              className="border-rose-300 py-1 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
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
