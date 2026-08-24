import { useCallback, useMemo } from "preact/hooks";
import type { DatabaseEngine } from "src/types";
import type { QueryResult } from "src/lib/tauri";
import { runSqlQuery, startSqlQueryStream } from "src/lib/tauri/query";
import { isDDLStatement } from "src/utils/detect";
import { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";

type Options = {
  profileId: string;
  engine?: DatabaseEngine;
  metadata?: MetadataApi;
};

export type RunSqlReturn =
  | { mode: "direct"; result: QueryResult }
  | { mode: "stream"; opId: string };

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
    }): Promise<RunSqlReturn> => {
      const { connectionId, sql } = args;

      if (activeTab) {
        addQueryHistory(activeTab.id, sql);
      }

      const isDDL = isDDLStatement(sql);

      if (isDDL) {
        const res = await runSqlQuery(connectionId, sql);

        // Invalidate metadata logic
        if (opts?.metadata) {
          const metaKey = `${opts.engine}:${opts.profileId}`;
          opts.metadata.clear({ metaKey });

          // Background reload
          void opts.metadata.load({
            metaKey,
            engine: opts.engine,
            connectionId,
            force: true,
          });
        }

        return { mode: "direct", result: res };
      } else {
        const opId = await startSqlQueryStream(connectionId, sql);

        return { mode: "stream", opId };
      }
    },
    [activeTab, addQueryHistory, opts?.metadata, opts?.engine, opts?.profileId]
  );

  return {
    runSqlWithHistory: run,
  };
}
