import { useCallback, useState } from "preact/hooks";
import { v4 as uuid } from "uuid";
import type { SqlQuery } from "src/types";
import type { QueryResult } from "src/lib/tauri";
import { runSqlQuery } from "src/utils/query";

export function useSqlHistoryRunner() {
  const [sqlHistory, setSqlHistory] = useState<SqlQuery[]>([]);

  const run = useCallback(
    async (args: {
      connectionId: string;
      sql: string;
    }): Promise<QueryResult> => {
      const { connectionId, sql } = args;

      setSqlHistory((prev) => [
        { id: uuid(), sql, createdAt: Date.now() } as unknown as SqlQuery,
        ...prev,
      ]);

      return await runSqlQuery(connectionId, sql);
    },
    []
  );

  const clear = useCallback(() => setSqlHistory([]), []);

  return {
    sqlHistory,
    setSqlHistory,
    runSqlWithHistory: run,
    clearHistory: clear,
  };
}
