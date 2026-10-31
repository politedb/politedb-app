import { useCallback, useMemo } from "preact/hooks";
import { assertTabTarget } from "src/lib/tabs/assertTabTarget";
import type { DatabaseEngine } from "src/types";
import type { QueryResult } from "src/lib/tauri";
import { runSqlQuery, startSqlQueryStream } from "src/lib/tauri/query";
import { isDDLStatement } from "src/lib/sql/detect";
import { MetadataApi } from "src/hooks/useDatabaseMetadata";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";

type Options = {
  profileId: string;
  engine?: DatabaseEngine;
  metadata?: MetadataApi;
  /** The tab's database, for the metadata reload after DDL (R2). */
  currentDatabase?: string;
};

/**
 * The profile tab a statement started from, captured before any async step so
 * a later history write still goes to that tab.
 */
export type SqlHistoryTarget = {
  tabId: string;
  label: string;
  /** Still open and on the same runtime connection as when captured. */
  isCurrent: () => boolean;
  /**
   * Adds to that tab's history; dropped if the tab was closed or moved to
   * another connection meanwhile.
   */
  record: (sql: string, kind: "explain_analyze") => void;
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
      /** The tab the work belongs to, fixed when it starts (D3). */
      tabId: string;
      windowId?: string;
    }): Promise<RunSqlReturn> => {
      const { connectionId, sql } = args;

      // D3: the work's own tab, captured now (never whichever tab becomes
      // active later), must own this connection on its target. Nothing is
      // sent, or recorded, otherwise.
      const origin = args.tabId;
      assertTabTarget(origin, connectionId);

      addQueryHistory(origin, sql);

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
            currentDatabase: opts.currentDatabase,
            force: true,
          });
        }

        return { mode: "direct", result: res };
      } else {
        const opId = await startSqlQueryStream(connectionId, sql);

        return { mode: "stream", opId };
      }
    },
    [
      addQueryHistory,
      opts?.metadata,
      opts?.engine,
      opts?.profileId,
      opts?.currentDatabase,
    ]
  );

  const captureHistoryTarget = useCallback((): SqlHistoryTarget | null => {
    if (!activeTab) return null;
    const tabId = activeTab.id;
    const runtimeId = activeTab.runtimeConnectionId;
    // Same tab, still on the same connection (not reconnected or reused).
    const isCurrent = () =>
      useScreenStore
        .getState()
        .profileTabs.some(
          (tab) => tab.id === tabId && tab.runtimeConnectionId === runtimeId
        );
    return {
      tabId,
      label: activeTab.label,
      isCurrent,
      record: (sql, kind) => {
        if (!isCurrent()) return;
        useConnectionStore.getState().addQueryHistory(tabId, sql, { kind });
      },
    };
  }, [activeTab]);

  return {
    runSqlWithHistory: run,
    captureHistoryTarget,
  };
}
