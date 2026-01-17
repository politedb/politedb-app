import { Clock } from "../../components/icons";
import { Button } from "../../components/common/Button";
import { Box } from "../../components/common/Box";
import { SqlQuery } from "../../types";

interface Props {
  queries: SqlQuery[];
  onClear?: () => void;
}

export function QueryHistory({ queries, onClear }: Props) {
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
            {queries.map((query, index) => (
              <div
                key={index}
                class="border-b border-neutral-100 px-4 py-3 transition-colors hover:bg-neutral-50"
              >
                <div class="mb-1 flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <Clock className="size-3.5 text-neutral-600" />
                    <span class="text-xs text-neutral-600">
                      {query.timestamp.toString()}
                    </span>
                  </div>
                </div>
                <p class="text-xs font-medium break-all text-neutral-700">
                  {query.sql}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
