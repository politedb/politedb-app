import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { ConnectionFormDialog } from "./connection-form/ConnectionFormDialog.tsx";
import { OverlayModal } from "./modal/OverlayModal";
import { Button } from "./common/Button";
import { DbIcon } from "./icons/DbIcon";
import { Search, X } from "./icons";

import type { DatabaseEngine, DatabaseType } from "../types";
import { SUPPORTED_DATABASES } from "../constant.ts";

function normalizeQuery(q: string) {
  return q.trim().toLowerCase();
}

function matchesDb(db: DatabaseType & { desc?: string }, q: string) {
  const query = normalizeQuery(q);
  if (!query) return true;

  const hay = [
    db.label,
    db.abbreviation,
    db.engine,
    db.desc ?? "",
    db.available ? "available" : "coming soon",
  ]
    .join(" ")
    .toLowerCase();

  return hay.includes(query);
}

function findDb(engine: DatabaseEngine | null) {
  if (!engine) return null;
  return SUPPORTED_DATABASES.find((d) => d.engine === engine) ?? null;
}

function firstAvailableEngine(
  list: readonly (DatabaseType & { desc?: string })[]
) {
  // Option 3: auto-select Postgres if available, else first available
  const pg = list.find((d) => d.engine === "postgres" && d.available);
  if (pg) return pg.engine;

  const first = list.find((d) => d.available);
  return first ? first.engine : null;
}

function RowBadge(props: { kind: "available" | "soon" }) {
  const { kind } = props;
  if (kind === "available") {
    return (
      <span class="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
        Available
      </span>
    );
  }
  return (
    <span class="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
      Coming soon
    </span>
  );
}

function EngineRow(props: {
  db: DatabaseType & { desc?: string };
  active: boolean;
  onPick: () => void;
}) {
  const { db, active, onPick } = props;
  const disabled = !db.available;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onPick();
      }}
      class={[
        "w-full",
        "flex items-center gap-3",
        "rounded-xl border px-3 py-2",
        "text-left transition",
        disabled
          ? "cursor-not-allowed border-slate-100 bg-white opacity-60"
          : active
            ? "border-blue-500 bg-blue-50"
            : "border-slate-200 bg-white hover:bg-slate-50",
      ].join(" ")}
    >
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200">
        <DbIcon
          engine={db.engine}
          abbreviation={db.abbreviation}
          px={28}
          className="h-6 w-6"
        />
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <div class="truncate text-sm font-semibold text-slate-900">
            {db.label}
          </div>
          <RowBadge kind={db.available ? "available" : "soon"} />
        </div>

        {db.desc ? (
          <div class="mt-0.5 truncate text-xs text-slate-500" title={db.desc}>
            {db.desc}
          </div>
        ) : null}
      </div>

      {!disabled ? (
        <div class="ml-2 shrink-0 text-slate-400">›</div>
      ) : (
        <div class="ml-2 shrink-0 text-slate-300">•</div>
      )}
    </button>
  );
}

export function ConnectionModal(props: {
  onSaved: () => void;
  onClose: () => void;
  showDatabaseForm: DatabaseEngine | undefined;
  setShowDatabaseForm: (show: DatabaseEngine | undefined) => void;
}) {
  const { onClose, onSaved, showDatabaseForm, setShowDatabaseForm } = props;

  const [query, setQuery] = useState("");
  const [selectedEngine, setSelectedEngine] = useState<DatabaseEngine | null>(
    null
  );
  const [activeIndex, setActiveIndex] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    return SUPPORTED_DATABASES.filter((db) => matchesDb(db, query));
  }, [query]);

  const anyAvailable = filtered.some((d) => d.available);

  const availableEngines = filtered
    .filter((d) => d.available)
    .map((d) => d.engine);

  // Option 3: auto-select Postgres (or first available) when modal opens / query changes
  useEffect(() => {
    if (showDatabaseForm) return;

    // focus search input
    searchRef.current?.focus();

    // keep selection valid
    const current = findDb(selectedEngine);
    const stillVisible =
      current && filtered.some((d) => d.engine === current.engine);
    const stillAvailable = current?.available;

    if (!stillVisible || !stillAvailable) {
      const next = firstAvailableEngine(filtered);
      setSelectedEngine(next);
    }
  }, [filtered, selectedEngine, showDatabaseForm]);

  // keep activeIndex in range + prefer selectedEngine if present
  useEffect(() => {
    if (showDatabaseForm) return;

    if (!filtered.length) {
      setActiveIndex(0);
      return;
    }

    const idxSelected = selectedEngine
      ? filtered.findIndex((d) => d.engine === selectedEngine)
      : -1;

    if (idxSelected >= 0) {
      setActiveIndex(idxSelected);
      return;
    }

    setActiveIndex((i) => Math.min(i, filtered.length - 1));
  }, [filtered, selectedEngine, showDatabaseForm]);

  function openForm(engine: DatabaseEngine) {
    setSelectedEngine(engine);
    setShowDatabaseForm(engine);
  }

  function pickActive() {
    const row = filtered[activeIndex];
    if (!row || !row.available) return;
    openForm(row.engine);
  }

  // ===== Form Mode =====
  if (showDatabaseForm) {
    const selected = findDb(selectedEngine);

    return (
      <OverlayModal open onClose={onClose}>
        {selected?.engine && availableEngines.includes(selected?.engine) ? (
          <ConnectionFormDialog
            onSaved={onSaved}
            onClose={onClose}
            engine={selected?.engine}
          />
        ) : (
          <div class="mx-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div class="text-lg font-semibold text-slate-900">
              {selected?.label ?? "This database"} is coming soon
            </div>
            <div class="mt-2 text-sm text-slate-600">
              We’ll add this engine in a later update.
            </div>

            <div class="mt-5 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowDatabaseForm(undefined)}
              >
                Back
              </Button>
              <Button variant="default" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
      </OverlayModal>
    );
  }

  return (
    <OverlayModal open onClose={onClose}>
      <div
        class="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            pickActive();
            return;
          }
        }}
        tabIndex={0}
      >
        {/* Header */}
        <div class="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <div class="text-lg font-semibold text-slate-900">
              New Connection
            </div>
            <div class="mt-0.5 text-xs text-slate-500">
              Choose a database engine to continue
            </div>
          </div>

          <Button
            variant="ghost"
            className="rounded-full p-2"
            onClick={onClose}
          >
            <X className="size-4 text-slate-600" />
          </Button>
        </div>

        {/* Search */}
        <div class="border-b border-slate-200 bg-slate-50 px-6 py-3">
          <div class="relative">
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder="Search engines…"
              onInput={(e) => setQuery(e.currentTarget.value)}
              class="h-10 w-full rounded-xl border border-slate-300 bg-white pr-3 pl-10 text-sm font-medium text-slate-900 outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-200/60"
            />
            <Search className="absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-slate-400" />
          </div>

          {!anyAvailable ? (
            <div class="mt-2 text-xs text-rose-600">
              No available engines in this list.
            </div>
          ) : (
            <div class="mt-2 text-xs text-slate-500">
              Tip: ↑/↓ to navigate, Enter to select, Esc to close.
            </div>
          )}
        </div>

        {/* List */}
        <div class="max-h-[64vh] overflow-y-auto bg-white p-4">
          {filtered.length === 0 ? (
            <div class="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center">
              <div class="text-sm font-semibold text-slate-800">No results</div>
              <div class="mt-1 text-sm text-slate-500">
                Try a different keyword.
              </div>
            </div>
          ) : (
            <div class="space-y-2">
              {filtered.map((db, idx) => (
                <EngineRow
                  key={db.engine}
                  db={db}
                  active={idx === activeIndex}
                  onPick={() => openForm(db.engine)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer (optional minimal) */}
        <div class="flex items-center justify-between border-t border-slate-200 bg-white px-6 py-3">
          <div class="text-xs text-slate-500"></div>
          <div class="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="default"
              disabled={!anyAvailable}
              onClick={pickActive}
            >
              Continue
            </Button>
          </div>
        </div>
      </div>
    </OverlayModal>
  );
}
