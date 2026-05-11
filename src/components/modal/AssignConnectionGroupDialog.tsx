import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import type { ConnectionGroup } from "src/stores/connectionGroups";
import { SearchIcon, XIcon } from "src/components/icons";
import { cn } from "src/utils/cn";
import { useEffect, useMemo, useState } from "preact/hooks";

export function AssignConnectionGroupDialog(props: {
  open: boolean;
  onClose: () => void;
  connectionLabel: string;
  groups: ConnectionGroup[];
  selectedGroupIds?: string[];
  onSave: (groupIds: string[]) => void | Promise<void>;
}) {
  const { open, onClose, connectionLabel, groups, selectedGroupIds, onSave } =
    props;
  const [values, setValues] = useState<string[]>(selectedGroupIds ?? []);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const selectedGroupIdsKey = (selectedGroupIds ?? []).join("\u0000");

  useEffect(() => {
    if (!open) return;
    setValues(selectedGroupIds ?? []);
    setQuery("");
    setFocused(false);
  }, [open, selectedGroupIdsKey]);

  const selectedGroups = useMemo(() => {
    const selected = new Set(values);
    return groups.filter((group) => selected.has(group.id));
  }, [groups, values]);

  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return groups.filter((group) => {
      if (normalizedQuery && !group.name.toLowerCase().includes(normalizedQuery)) {
        return false;
      }
      return true;
    });
  }, [groups, query]);

  function toggleGroup(groupId: string) {
    setValues((current) =>
      current.includes(groupId)
        ? current.filter((id) => id !== groupId)
        : [...current, groupId]
    );
    setQuery("");
  }

  function removeGroup(groupId: string) {
    setValues((current) => current.filter((id) => id !== groupId));
  }

  return (
    <Dialog open={open} onClose={onClose} size="sm" className="overflow-visible">
      <DialogHeader>
        <DialogTitle>Move Connection To Groups</DialogTitle>
      </DialogHeader>
      <DialogContent className="gap-2 pt-0">
        <p class="text-sm text-slate-600">
          Choose one or more groups for{" "}
          <span class="font-semibold">{connectionLabel}</span>.
        </p>

        <div class="relative">
          <div
            class={cn(
              "flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border bg-white px-3 py-2",
              focused ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200"
            )}
          >
            {selectedGroups.map((group) => (
              <span
                key={group.id}
                class="inline-flex max-w-full items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700"
              >
                <span class="truncate">{group.name}</span>
                <button
                  type="button"
                  class="rounded-full p-0.5 hover:bg-blue-100"
                  onClick={() => removeGroup(group.id)}
                  aria-label={`Remove ${group.name}`}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
            <div class="flex min-w-32 flex-1 items-center gap-1">
              <SearchIcon className="size-4 shrink-0 text-slate-400" />
              <input
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => window.setTimeout(() => setFocused(false), 120)}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && !query && values.length) {
                    setValues((current) => current.slice(0, -1));
                  }
                }}
                placeholder={selectedGroups.length ? "Add group..." : "Search groups..."}
                class="min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
              />
            </div>
          </div>

          {focused ? (
            <div class="absolute z-20 mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
              {groups.length ? (
                filteredGroups.length ? (
                  filteredGroups.map((group) => {
                    const selected = values.includes(group.id);
                    return (
                      <button
                        key={group.id}
                        type="button"
                        class={cn(
                          "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm",
                          selected
                            ? "bg-blue-50 text-blue-700"
                            : "text-slate-700 hover:bg-slate-50"
                        )}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleGroup(group.id)}
                      >
                        <span class="min-w-0 flex-1 truncate">{group.name}</span>
                        {selected ? (
                          <span class="text-sm font-bold text-blue-600">✓</span>
                        ) : null}
                      </button>
                    );
                  })
                ) : (
                  <div class="px-3 py-2 text-sm text-slate-500">
                    No matching groups.
                  </div>
                )
              ) : (
                <div class="px-3 py-2 text-sm text-slate-500">
                  No groups yet. Create a group first.
                </div>
              )}
            </div>
          ) : null}
        </div>

        {values.length ? (
          <button
            type="button"
            class="self-start text-xs font-semibold text-slate-500 hover:text-slate-900"
            onClick={() => setValues([])}
          >
            Clear groups
          </button>
        ) : (
          <p class="text-xs text-slate-500">Leave empty to keep this connection ungrouped.</p>
        )}
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="default"
          onClick={() => void onSave(values)}
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
