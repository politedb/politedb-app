import { useCallback, useState } from "preact/hooks";
import { v4 as uuid } from "uuid";
import type { SqlQuery, DatabaseEngine } from "src/types";
import type { QueryResult } from "src/lib/tauri";
import { runSqlQuery } from "src/utils/query";
import { isDDLStatement } from "src/utils/detect";
import { MetadataApi } from "src/hooks/useDatabaseMetadata";

type Options = {
  profileId: string;
  engine?: DatabaseEngine;

  metadata?: MetadataApi;
};

export function useSqlHistoryRunner(opts?: Options) {
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

      const res = await runSqlQuery(connectionId, sql);

      // ✅ invalidate metadata if DDL succeeded
      if (opts?.metadata && isDDLStatement(sql)) {
        const metaKey = `${opts.engine}:${opts.profileId}`;
        opts.metadata.invalidate({ metaKey });

        // background reload (don’t await)
        void opts.metadata.load({
          metaKey,
          engine: opts.engine,
          connectionId,
          force: true,
        });
      }

      return res;
    },
    [opts?.engine, opts?.metadata]
  );

  const clear = useCallback(() => setSqlHistory([]), []);

  return {
    sqlHistory,
    setSqlHistory,
    runSqlWithHistory: run,
    clearHistory: clear,
  };
}
