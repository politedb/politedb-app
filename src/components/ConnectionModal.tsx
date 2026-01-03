import { useMemo, useState } from "preact/hooks";
import { Search, X } from "./icons";
import { PostgresConnectionDialog } from "./PostgresConnectionForm";

type DatabaseType = {
  id: string;
  name: string;
  abbreviation: string;
  color: string;
  available: boolean;
};

const DATABASE_TYPES: DatabaseType[] = [
  {
    id: "postgresql",
    name: "PostgreSQL",
    abbreviation: "Pg",
    color: "bg-blue-600",
    available: true,
  },
  {
    id: "redshift",
    name: "Amazon Redshift",
    abbreviation: "Rs",
    color: "bg-blue-600",
    available: false,
  },
  { id: "mysql", name: "MySQL", abbreviation: "Ms", color: "bg-orange-500", available: false },
  {
    id: "mariadb",
    name: "MariaDB & SingleStore",
    abbreviation: "Mr",
    color: "bg-teal-500",
    available: false,
  },
  {
    id: "sqlserver",
    name: "Microsoft SQL Server",
    abbreviation: "Ss",
    color: "bg-slate-600",
    available: false,
  },
  { id: "cassandra", name: "Cassandra", abbreviation: "Cs", color: "bg-black", available: false },
  {
    id: "clickhouse",
    name: "ClickHouse",
    abbreviation: "Ch",
    color: "bg-yellow-500",
    available: false,
  },
  { id: "bigquery", name: "BigQuery", abbreviation: "Bq", color: "bg-blue-500", available: false },
  {
    id: "dynamodb",
    name: "DynamoDB (Beta)",
    abbreviation: "Dn",
    color: "bg-slate-700",
    available: false,
  },
  { id: "libsql", name: "LibSQL", abbreviation: "Ls", color: "bg-green-600", available: false },
  { id: "d1", name: "Cloudflare D1", abbreviation: "D1", color: "bg-orange-600", available: false },
  { id: "mongo", name: "Mongo", abbreviation: "Mg", color: "bg-green-500", available: false },
  { id: "snowflake", name: "Snowflake", abbreviation: "Nf", color: "bg-sky-400", available: false },
  { id: "redis", name: "Redis", abbreviation: "Re", color: "bg-red-700", available: false },
  { id: "sqlite", name: "SQLite", abbreviation: "Sl", color: "bg-purple-600", available: false },
  { id: "duckdb", name: "DuckDB", abbreviation: "Du", color: "bg-black", available: false },
  { id: "oracle", name: "Oracle", abbreviation: "Oc", color: "bg-red-600", available: false },
  {
    id: "cockroach",
    name: "Cockroach",
    abbreviation: "Cr",
    color: "bg-green-600",
    available: false,
  },
];

export function ConnectionModal({
  onClose,
  onSaved,
  showDatabaseForm,
  setShowDatabaseForm,
}: {
  onSaved: () => void;
  onClose: () => void;
  showDatabaseForm: boolean;
  setShowDatabaseForm: (show: boolean) => void;
}) {
  const [dbTypeSearchQuery, setDbTypeSearchQuery] = useState("");
  const [selectedDatabaseType, setSelectedDatabaseType] = useState<string | null>(null);

  const filteredDatabaseTypes = useMemo(() => {
    if (!dbTypeSearchQuery.trim()) return DATABASE_TYPES;

    const query = dbTypeSearchQuery.toLowerCase();
    return DATABASE_TYPES.filter(
      (db) =>
        db.name.toLowerCase().includes(query) ||
        db.abbreviation.toLowerCase().includes(query) ||
        db.id.toLowerCase().includes(query)
    );
  }, [dbTypeSearchQuery]);

  if (showDatabaseForm) {
    return (
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
        <div class="flex-1 overflow-y-auto">
          {selectedDatabaseType === "postgresql" && (
            <PostgresConnectionDialog onSaved={onSaved} onClose={onClose} />
          )}
          {selectedDatabaseType !== "postgresql" && (
            <div class="p-6 text-center">
              <p class="text-slate-500">
                {DATABASE_TYPES.find((db) => db.id === selectedDatabaseType)?.name} connection form
                coming soon
              </p>
              <button
                type="button"
                onClick={() => {
                  setShowDatabaseForm(false);
                  setSelectedDatabaseType(null);
                }}
                class="mt-4 text-blue-600 hover:text-blue-700 text-sm font-medium cursor-pointer"
              >
                ← Back to database selection
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div class="w-full max-w-4xl max-h-[90vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0 bg-white">
          <h2 class="text-lg font-semibold text-slate-900">New Connection</h2>
          <button
            type="button"
            onClick={onClose}
            class="h-8 w-8 rounded-lg hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="size-4 text-slate-600" />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto bg-slate-50 p-6">
          {/* Search Bar */}
          <div class="mb-6">
            <div class="relative">
              <input
                type="text"
                placeholder="Search..."
                value={dbTypeSearchQuery}
                onInput={(e) => setDbTypeSearchQuery(e.currentTarget.value)}
                class="w-full h-10 pl-10 pr-4 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            </div>
          </div>

          {/* Database Type Grid */}
          <div class="grid grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-4 mb-6">
            {filteredDatabaseTypes.map((db) => {
              const isSelected = selectedDatabaseType === db.id;
              return (
                <button
                  key={db.id}
                  type="button"
                  onClick={() => {
                    if (db.available) {
                      setSelectedDatabaseType(db.id);
                    }
                  }}
                  disabled={!db.available}
                  class={`flex flex-col items-center gap-2 p-3 rounded-xl border transition-all ${
                    isSelected && db.available
                      ? "border-blue-600 bg-blue-50 shadow-md cursor-pointer"
                      : db.available
                      ? "border-slate-200 bg-white hover:border-blue-500 hover:shadow-md cursor-pointer"
                      : "border-slate-100 bg-slate-50 opacity-50 cursor-not-allowed"
                  }`}
                >
                  <div
                    class={`w-14 h-14 rounded-full ${
                      db.color
                    } flex items-center justify-center text-white font-semibold text-sm ${
                      !db.available ? "opacity-50" : ""
                    }`}
                  >
                    {db.abbreviation}
                  </div>
                  <div class="text-xs text-center text-slate-700 font-medium leading-tight">
                    {db.name}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Action Buttons */}
          <div class="flex items-center justify-between pt-4 border-t border-slate-200">
            <div class="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                class="p-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                class="p-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors cursor-pointer"
              >
                Import from URL
              </button>
              <button
                type="button"
                class="p-2 rounded-lg border border-slate-300 bg-white text-slate-700 text-sm font-medium hover:bg-slate-50 transition-colors cursor-pointer"
              >
                New Group
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                if (selectedDatabaseType) {
                  // Proceed to form with selected database
                  setShowDatabaseForm(true);
                } else {
                  // Select PostgreSQL by default if available
                  const postgres = filteredDatabaseTypes.find(
                    (db) => db.id === "postgresql" && db.available
                  );
                  if (postgres) {
                    setSelectedDatabaseType("postgresql");
                    setShowDatabaseForm(true);
                  }
                }
              }}
              disabled={!filteredDatabaseTypes.some((db) => db.available)}
              class="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
