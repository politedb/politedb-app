import { useCallback, useMemo } from "preact/hooks";
import type { DatabaseEngine } from "src/types";
import type { QueryResult } from "src/lib/tauri";
import { runSqlQuery } from "src/utils/query";
import { isDDLStatement } from "src/utils/detect";
import { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";

type Options = {
  profileId: string;
  engine?: DatabaseEngine;

  metadata?: MetadataApi;
};

export function useSqlHistoryRunner(opts?: Options) {
  const { addQueryHistory } = useConnectionStore();
  const { profileTabs, activeProfileScreen } = useScreenStore();

  const activeTab = useMemo(() => {
    if (!activeProfileScreen || activeProfileScreen === "main") return null;
    return profileTabs.find((t) => t.id === activeProfileScreen) ?? null;
  }, [profileTabs, activeProfileScreen]);

  const run = useCallback(
    async (args: {
      connectionId: string;
      sql: string;
    }): Promise<QueryResult> => {
      const { connectionId, sql } = args;

      addQueryHistory(activeTab!.id, sql);

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

  return {
    runSqlWithHistory: run,
  };
}
