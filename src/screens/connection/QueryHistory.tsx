import { useMemo, useCallback } from "preact/hooks";
import { Clock, Trash, Copy } from "src/components/icons";
import { Button } from "src/components/common/Button";
import { Box } from "src/components/common/Box";
import { cn } from "src/utils/cn";
import { useConnectionStore } from "src/stores/connection";
import type { ComponentChildren } from "preact";

interface Props {
  activeProfileId: string;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatTimestamp(ts: any) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts ?? "");

  const Y = d.getFullYear();
  const M = pad2(d.getMonth() + 1);
  const D = pad2(d.getDate());
  const h = pad2(d.getHours());
  const m = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  const ms4 = String(d.getMilliseconds() * 10).padStart(4, "0");

  return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms4}`;
}

function normalizeSql(sql: string) {
  return (sql ?? "").replace(/\r\n/g, "\n").trim();
}

export function highlightSql(sql: string): ComponentChildren {
  // Keep it light: strings -> numbers -> keywords -> identifiers
  const layers: Array<{ re: RegExp; cls: string }> = [
    // single-quoted strings
    { re: /'(?:''|[^'])*'/g, cls: "text-emerald-700" },
    // numbers
    { re: /\b\d+(?:\.\d+)?\b/g, cls: "text-orange-600" },
    // booleans/null
    { re: /\b(TRUE|FALSE|NULL)\b/gi, cls: "text-purple-700 font-medium" },
    // SQL keywords (basic set, covers most day-to-day)
    {
      re: /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AS|AND|OR|NOT|IN|IS|LIKE|ILIKE|BETWEEN|EXISTS|GROUP|BY|HAVING|ORDER|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|RETURNING|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|UNION|ALL|DISTINCT)\b/gi,
      cls: "text-blue-700 font-semibold",
    },
  ];

  let parts: any[] = [sql];

  for (const { re, cls } of layers) {
    parts = parts.flatMap((part) => {
      if (typeof part !== "string") return [part];

      const out: any[] = [];
      let last = 0;

      // reset lastIndex to be safe (global regex)
      re.lastIndex = 0;

      for (const m of part.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;

        if (start > last) out.push(part.slice(last, start));
        out.push(<span class={cls}>{m[0]}</span>);
        last = end;
      }

      if (last < part.length) out.push(part.slice(last));
      return out;
    });
  }

  return parts;
}

export function QueryHistory({ activeProfileId }: Props) {
  const queryHistory = useConnectionStore((s) => s.queryHistory);
  const clearHistory = useConnectionStore((s) => s.clearQueryHistory);

  const queries = useMemo(
    () => queryHistory[activeProfileId] ?? [],
    [queryHistory, activeProfileId]
  );

  const onClear = useCallback(
    () => clearHistory(activeProfileId),
    [clearHistory, activeProfileId]
  );

  const onCopy = useCallback(async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql);
    } catch {
      // ignore
    }
  }, []);

  return (
    <div class="flex h-full flex-col bg-white">
      <div class="flex items-center justify-between border-b border-neutral-200 bg-white px-3 py-2">
        <div class="flex items-center gap-2">
          <Clock className="size-4 text-neutral-500" />
          <h3 class="text-sm font-semibold text-neutral-800">SQL History</h3>
          {queries.length > 0 ? (
            <span class="text-[11px] text-neutral-500">({queries.length})</span>
          ) : null}
        </div>

        {queries.length > 0 && (
          <Button
            variant="ghost"
            onClick={onClear}
            class={cn(
              "h-7 px-2 text-xs text-neutral-600",
              "hover:bg-neutral-100"
            )}
            title="Clear history"
          >
            <Trash className="size-4" />
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
          <div class="font-mono text-[12px] leading-5">
            {queries.map((q, idx) => {
              const sqlRaw = q.sql ?? "";
              const sql = normalizeSql(sqlRaw);

              return (
                <div
                  key={idx}
                  class={cn(
                    "group flex items-start gap-3 px-3 py-2",
                    "border-b border-neutral-100",
                    "hover:bg-neutral-50"
                  )}
                  onClick={() => void onCopy(sqlRaw)}
                  title="Click to copy"
                >
                  <div class="w-48 shrink-0 pt-0.5 text-xs text-neutral-500 tabular-nums">
                    {formatTimestamp(q.timestamp)}
                  </div>

                  <div class="min-w-0 flex-1">
                    <div class="line-clamp-3 wrap-break-word">
                      {highlightSql(sql)}
                    </div>
                  </div>

                  <div class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      class="h-7 px-2 text-xs text-neutral-600 hover:bg-neutral-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onCopy(sqlRaw);
                      }}
                      title="Copy"
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div class="border-t border-neutral-200 bg-white px-3 py-2">
        <p class="text-[11px] text-neutral-500">Click a row to copy the SQL.</p>
      </div>
    </div>
  );
}
