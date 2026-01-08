import { Clock } from "../../components/icons";
import { Button } from "../../components/common/Button";
import { Box } from "../../components/common/Box";
import { SqlQuery } from "../../types";

interface Props {
  queries: SqlQuery[];
  onClear?: () => void;
  onSelectQuery?: (query: SqlQuery) => void;
}

export function QueryHistory({ queries, onClear, onSelectQuery }: Props) {
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const truncateSql = (sql: string, maxLength: number = 100) => {
    if (sql.length <= maxLength) return sql;
    return sql.substring(0, maxLength) + "...";
  };

  return (
    <div class="flex h-full flex-col bg-white">
      <div class="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
        <h3 class="text-sm font-semibold text-neutral-700">
          SQL Query History
        </h3>
        {queries.length > 0 && (
          <Button
            variant="ghost"
            onClick={onClear}
            class="h-6 px-2 text-xs text-neutral-600 hover:bg-neutral-100"
          >
            Clear
          </Button>
        )}
      </div>
      <div class="flex-1 overflow-y-auto">
        {queries.length === 0 ? (
          <Box className="p-8 text-center">
            <Clock className="mx-auto mb-2 size-8 text-neutral-300" />
            <p class="text-sm text-neutral-500">No query history</p>
          </Box>
        ) : (
          <div class="divide-y divide-neutral-100">
            {queries.map((query) => (
              <div
                key={query.id}
                class="group cursor-pointer border-b border-neutral-100 px-4 py-3 transition-colors hover:bg-neutral-50"
                onClick={() => onSelectQuery?.(query)}
              >
                <div class="mb-1 flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <Clock className="size-3.5 text-neutral-400" />
                    <span class="text-xs text-neutral-500">
                      {formatTime(query.timestamp)}
                    </span>
                    {query.executionTime && (
                      <span class="text-xs text-neutral-400">
                        ({query.executionTime}ms)
                      </span>
                    )}
                  </div>
                </div>
                <pre class="mt-1 overflow-x-auto text-xs text-neutral-700">
                  {truncateSql(query.sql)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
