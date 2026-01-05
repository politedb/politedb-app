import { useEffect, useMemo, useState } from "preact/hooks";
import { Search, X } from "./icons";
import { ConnectionFormDialog } from "./connection-form/ConnectionFormDialog.tsx";
import { Button } from "./common/Button";
import type { DatabaseEngine, DatabaseType } from "../types";
import { DbIcon } from "./icons/DbIcon";

export const DATABASE_TYPES: readonly DatabaseType[] = [
  {
    engine: "postgres",
    label: "PostgreSQL",
    abbreviation: "Pg",
    color: "bg-blue-600",
    available: true,
  },
  {
    engine: "mysql",
    label: "MySQL",
    abbreviation: "Ms",
    color: "bg-orange-500",
    available: true,
  },
  {
    engine: "redis",
    label: "Redis",
    abbreviation: "Re",
    color: "bg-red-700",
    available: true,
  },
  {
    engine: "mariadb",
    label: "MariaDB",
    abbreviation: "Mr",
    color: "bg-teal-500",
    available: false,
  },
  {
    engine: "mongo",
    label: "MongoDB",
    abbreviation: "Mg",
    color: "bg-green-500",
    available: false,
  },
  {
    engine: "sqlite",
    label: "SQLite",
    abbreviation: "Sl",
    color: "bg-purple-600",
    available: false,
  },
  {
    engine: "oracle",
    label: "Oracle",
    abbreviation: "Oc",
    color: "bg-red-600",
    available: false,
  },
] as const;

function normalizeQuery(q: string) {
  return q.trim().toLowerCase();
}

function matchesDb(db: DatabaseType, q: string) {
  const query = normalizeQuery(q);
  if (!query) return true;
  return (
    db.label.toLowerCase().includes(query) ||
    db.abbreviation.toLowerCase().includes(query) ||
    db.engine.includes(query)
  );
}

function findDb(engine: DatabaseEngine | null) {
  if (!engine) return null;
  return DATABASE_TYPES.find((d) => d.engine === engine) ?? null;
}

function pickDefaultAvailable(
  list: readonly DatabaseType[]
): DatabaseEngine | null {
  const postgres = list.find((d) => d.engine === "postgres" && d.available);
  if (postgres) return postgres.engine;

  const first = list.find((d) => d.available);
  return first ? first.engine : null;
}

export function ConnectionModal(props: {
  onSaved: () => void;
  onClose: () => void;
  showDatabaseForm: boolean;
  setShowDatabaseForm: (show: boolean) => void;
}) {
  const { onClose, onSaved, showDatabaseForm, setShowDatabaseForm } = props;

  const [query, setQuery] = useState("");
  const [selectedEngine, setSelectedEngine] = useState<DatabaseEngine | null>(
    null
  );

  const filtered = useMemo(() => {
    return DATABASE_TYPES.filter((db) => matchesDb(db, query));
  }, [query]);

  const anyAvailable = filtered.some((db) => db.available);

  useEffect(() => {
    if (!selectedEngine) return;
    const current = filtered.find((d) => d.engine === selectedEngine);
    if (!current || !current.available) setSelectedEngine(null);
  }, [filtered, selectedEngine]);

  function backToSelection() {
    setShowDatabaseForm(false);
    setSelectedEngine(null);
  }

  function selectEngine(engine: DatabaseEngine) {
    const db = DATABASE_TYPES.find((d) => d.engine === engine);
    if (!db || !db.available) return;
    setSelectedEngine(engine);
  }

  function openForm(engine: DatabaseEngine) {
    setSelectedEngine(engine);
    setShowDatabaseForm(true);
  }

  function handleCreate() {
    const selected = findDb(selectedEngine);
    if (selected?.available) return openForm(selected.engine);

    const next = pickDefaultAvailable(filtered);
    if (next) return openForm(next);
  }

  // ===== Form Mode =====
  if (showDatabaseForm) {
    const selected = findDb(selectedEngine);

    return (
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div class="flex-1 overflow-y-auto">
          {selected?.engine === "postgres" ? (
            <ConnectionFormDialog onSaved={onSaved} onClose={onClose} />
          ) : (
            <div class="p-6 text-center">
              <p class="text-slate-500">
                {selected?.label ?? "This database"} connection form coming soon
              </p>

              <button
                type="button"
                onClick={backToSelection}
                class="mt-4 cursor-pointer text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                ← Back to database selection
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ===== Selection Mode =====
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div class="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div class="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <h2 class="text-lg font-semibold text-slate-900">New Connection</h2>

          <Button
            variant="ghost"
            className="rounded-full p-2"
            onClick={onClose}
          >
            <X className="size-4 text-slate-600" />
          </Button>
        </div>

        <div class="flex-1 overflow-y-auto bg-slate-50 p-6">
          <div class="mb-6">
            <div class="relative">
              <input
                type="text"
                placeholder="Search..."
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
                class="h-10 w-full rounded-lg border border-slate-300 bg-white pr-4 pl-10 text-sm text-slate-900 placeholder:text-slate-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              <Search className="absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-slate-400" />
            </div>
          </div>

          <div class="mb-6 grid grid-cols-4 gap-4 md:grid-cols-6">
            {filtered.map((db) => {
              const isSelected = selectedEngine === db.engine;
              const enabled = db.available;

              const cardClass = enabled
                ? isSelected
                  ? "border-blue-600 bg-blue-50 shadow-md"
                  : "border-slate-200 bg-white hover:border-blue-500 hover:shadow-md"
                : "cursor-not-allowed border-slate-100 bg-slate-50 opacity-50";

              return (
                <button
                  key={db.engine}
                  type="button"
                  disabled={!enabled}
                  onClick={() => selectEngine(db.engine)}
                  class={`flex flex-col items-center gap-2 rounded-xl border p-3 text-left transition-all ${cardClass}`}
                >
                  <div
                    class={`flex h-12 w-20 items-center justify-center rounded-full text-sm font-semibold text-white ${
                      !enabled ? "opacity-50" : ""
                    }`}
                  >
                    <DbIcon
                      engine={db.engine}
                      abbreviation={db.abbreviation}
                      className="shrink-0"
                      size="md"
                    />
                  </div>
                  <div class="text-center text-xs leading-tight font-medium text-slate-700">
                    {db.label}
                  </div>
                </button>
              );
            })}
          </div>

          <div class="flex items-center justify-between border-t border-slate-200 pt-4">
            <div class="flex gap-2">
              <Button variant="outline">Import from URL</Button>
              <Button variant="outline">New Group</Button>
            </div>

            <Button onClick={handleCreate} disabled={!anyAvailable}>
              Create
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
