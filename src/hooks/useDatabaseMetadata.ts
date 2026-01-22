import { useCallback, useRef, useState } from "preact/hooks";
import type { DatabaseEngine, TableItem } from "src/types";
import { runSqlQuery } from "src/lib/tauri/query";
import { getMetadataQueries } from "src/lib/queries/metadata";
import { cellToString } from "src/utils/convert";

export type DbMetadata = {
  engine?: DatabaseEngine;

  schemas: string[];
  tables: TableItem[];
  columnsByTable: Record<string, string[]>;

  loading: boolean;
  loaded: boolean;
  error: string | null;

  progress: number; // 0..100
  stage: "idle" | "schemas" | "tables" | "columns" | "done" | "error";
};

function emptyMeta(engine?: DatabaseEngine): DbMetadata {
  return {
    engine,
    schemas: [],
    tables: [],
    columnsByTable: {},
    loading: false,
    loaded: false,
    error: null,
    progress: 0,
    stage: "idle",
  };
}

/**
 * IMPORTANT:
 * - Cache key MUST be stable across reconnects (do NOT use runtimeConnectionId).
 * - Example metaKey: `${engine}:${profileId}` or `${engine}:${host}:${port}:${db}:${user}`
 */
export function useDatabaseMetadata() {
  const cacheRef = useRef<Record<string, DbMetadata>>({});
  const inflightRef = useRef<Record<string, Promise<DbMetadata> | null>>({});
  const [, bump] = useState(0);
  const touch = () => bump((v) => v + 1);

  const setCache = (metaKey: string, patch: Partial<DbMetadata>) => {
    const prev = cacheRef.current[metaKey] ?? emptyMeta(patch.engine);
    cacheRef.current[metaKey] = { ...prev, ...patch };
    touch();
  };

  const load = useCallback(
    async (args: {
      metaKey: string; // ✅ stable
      engine?: DatabaseEngine;
      connectionId: string; // ✅ runtime id for executing queries
      force?: boolean;
    }) => {
      const { metaKey, engine, connectionId, force = false } = args;

      const existing = cacheRef.current[metaKey];

      // If loaded and not forced -> fast path
      if (existing?.loaded && !force) return existing;

      // If already loading -> reuse inflight
      if (existing?.loading && inflightRef.current[metaKey]) {
        return inflightRef.current[metaKey]!;
      }

      // Start/restart load
      setCache(metaKey, {
        engine,
        schemas: force ? [] : (existing?.schemas ?? []),
        tables: force ? [] : (existing?.tables ?? []),
        columnsByTable: force ? {} : (existing?.columnsByTable ?? {}),
        loading: true,
        loaded: false,
        error: null,
        progress: 0,
        stage: "schemas",
      });

      const p = (async (): Promise<DbMetadata> => {
        try {
          const q = getMetadataQueries(engine);

          // Schemas (0 -> 10)
          const schemasRes = await runSqlQuery(connectionId, q.schemasQuery);
          const schemas = (schemasRes.rows ?? [])
            .map((r: any) => cellToString(r?.[0]))
            .filter(Boolean);
          setCache(metaKey, { schemas, progress: 10, stage: "tables" });

          // Tables (10 -> 25)
          const tablesRes = await runSqlQuery(connectionId, q.tablesQuery);
          const tables: TableItem[] = (tablesRes.rows ?? [])
            .map((r: any): TableItem => {
              const rawKind = cellToString(r?.[2]).toUpperCase();
              const kind: TableItem["kind"] =
                rawKind === "VIEW" ? "view" : "table";

              return {
                schema: cellToString(r?.[0]),
                name: cellToString(r?.[1]),
                kind,
              };
            })
            .filter((t: TableItem) => Boolean(t.schema && t.name));
          setCache(metaKey, { tables, progress: 25, stage: "columns" });

          // Columns (25 -> 100)
          const colsRes = await runSqlQuery(connectionId, q.columnsQuery);
          const rows = colsRes.rows ?? [];
          const columnsByTable: Record<string, string[]> = {};
          const total = rows.length || 1;

          for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const schema = cellToString(r?.[0]);
            const table = cellToString(r?.[1]);
            const col = cellToString(r?.[2]);
            if (!schema || !table || !col) continue;

            const k = `${schema}.${table}`;
            if (!columnsByTable[k]) columnsByTable[k] = [];
            columnsByTable[k].push(col);

            // throttle progress updates
            if (i % 250 === 0) {
              const prog = 25 + Math.floor((i / total) * 75);
              setCache(metaKey, { progress: Math.min(99, prog) });
            }
          }

          setCache(metaKey, {
            columnsByTable,
            loading: false,
            loaded: true,
            error: null,
            progress: 100,
            stage: "done",
          });

          return cacheRef.current[metaKey]!;
        } catch (e: any) {
          const msg = e?.message
            ? String(e.message)
            : String(e) || "LOAD_METADATA_FAILED";

          setCache(metaKey, {
            loading: false,
            loaded: false,
            error: msg,
            progress: 0,
            stage: "error",
          });

          return cacheRef.current[metaKey]!;
        } finally {
          inflightRef.current[metaKey] = null;
        }
      })();

      inflightRef.current[metaKey] = p;
      return p;
    },
    []
  );

  const get = useCallback(
    (args: {
      metaKey: string;
      engine?: DatabaseEngine;
      lazy?: boolean;
      connectionId?: string;
    }) => {
      const { metaKey, engine, lazy = true, connectionId } = args;

      const meta = cacheRef.current[metaKey] ?? emptyMeta(engine);

      // Lazy load only if we have connectionId to execute queries
      if (
        lazy &&
        connectionId &&
        !meta.loaded &&
        !meta.loading &&
        !meta.error
      ) {
        void load({ metaKey, engine, connectionId });
      }

      return meta;
    },
    [load]
  );

  const invalidate = useCallback((args: { metaKey: string }) => {
    const { metaKey } = args;
    delete cacheRef.current[metaKey];
    inflightRef.current[metaKey] = null;
    touch();
  }, []);

  const refresh = useCallback(
    async (args: {
      metaKey: string;
      engine?: DatabaseEngine;
      connectionId: string;
    }) => {
      const { metaKey, engine, connectionId } = args;
      invalidate({ metaKey });
      return await load({ metaKey, engine, connectionId, force: true });
    },
    [invalidate, load]
  );

  const clear = invalidate;

  return { get, load, refresh, invalidate, clear };
}

export type MetadataApi = ReturnType<typeof useDatabaseMetadata>;
