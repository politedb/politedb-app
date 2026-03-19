import { useCallback, useRef, useState } from "preact/hooks";
import type { DatabaseEngine, TableItem } from "src/types";
import { runSqlQuery } from "src/lib/tauri/query";
import {
  mongoCollectionOverview,
  mongoListCollections,
  mongoListDatabases,
} from "src/lib/tauri";
import { getMetadataQueries } from "src/lib/queries/metadata";
import { cellToString } from "src/utils/convert";

export type FunctionItem = {
  schema: string;
  name: string;
  args?: string;
};

export type DbMetadata = {
  engine?: DatabaseEngine;

  schemas: string[];
  functions: FunctionItem[];
  tables: TableItem[];
  columnsByTable: Record<string, string[]>;
  columnsLoaded: boolean;

  loading: boolean;
  loaded: boolean;
  error: string | null;

  progress: number; // 0..100
  stage:
    | "idle"
    | "schemas"
    | "functions"
    | "tables"
    | "columns"
    | "done"
    | "error";
};

function emptyMeta(engine?: DatabaseEngine): DbMetadata {
  return {
    engine,
    schemas: [],
    functions: [],
    tables: [],
    columnsByTable: {},
    columnsLoaded: false,
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

  const runMetadataQuery = useCallback(
    (connectionId: string, sql: string) =>
      runSqlQuery(connectionId, sql, {
        // Metadata queries often return many rows; larger batches reduce FE/BE
        // event churn and speed up sidebar hydration noticeably.
        batchSize: 1000,
      }),
    []
  );

  const load = useCallback(
    async (args: {
      metaKey: string; // ✅ stable
      engine?: DatabaseEngine;
      connectionId: string; // ✅ runtime id for executing queries
      force?: boolean;
      includeColumns?: boolean;
    }) => {
      const {
        metaKey,
        engine,
        connectionId,
        force = false,
        includeColumns = false,
      } = args;

      const existing = cacheRef.current[metaKey];

      // If loaded and not forced -> fast path
      if (
        existing?.loaded &&
        !force &&
        (!includeColumns || existing.columnsLoaded)
      ) {
        return existing;
      }

      // If already loading -> reuse inflight
      if (existing?.loading && inflightRef.current[metaKey]) {
        return inflightRef.current[metaKey]!;
      }

      // Start/restart load
      setCache(metaKey, {
        engine,
        schemas: force ? [] : (existing?.schemas ?? []),
        functions: force ? [] : (existing?.functions ?? []),
        tables: force ? [] : (existing?.tables ?? []),
        columnsByTable:
          force && includeColumns ? {} : (existing?.columnsByTable ?? {}),
        columnsLoaded:
          includeColumns && force ? false : (existing?.columnsLoaded ?? false),
        loading: true,
        loaded: false,
        error: null,
        progress: 0,
        stage: "schemas",
      });

      const p = (async (): Promise<DbMetadata> => {
        try {
          if (engine === "mongo") {
            const schemas = await mongoListDatabases(connectionId);
            setCache(metaKey, { schemas, progress: 20, stage: "tables" });

            const tables: TableItem[] = [];
            const columnsByTable: Record<string, string[]> = {};

            for (let i = 0; i < schemas.length; i++) {
              const schema = schemas[i]!;
              const collections = await mongoListCollections(
                connectionId,
                schema
              );

              for (const name of collections) {
                tables.push({ schema, name, kind: "table" });

                if (includeColumns) {
                  const overview = await mongoCollectionOverview({
                    connectionId,
                    database: schema,
                    collection: name,
                    sampleSize: 50,
                  });
                  columnsByTable[`${schema}.${name}`] = overview.columns.map(
                    (c) => c.name
                  );
                }
              }

              const prog =
                20 + Math.floor(((i + 1) / Math.max(1, schemas.length)) * 70);
              setCache(metaKey, { progress: Math.min(95, prog) });
            }

            setCache(metaKey, {
              functions: [],
              tables,
              columnsByTable,
              columnsLoaded: includeColumns,
              loading: false,
              loaded: true,
              error: null,
              progress: 100,
              stage: "done",
            });

            return cacheRef.current[metaKey]!;
          }

          const q = getMetadataQueries(engine);

          const [schemasRes, functionsRes, tablesRes, colsRes] =
            await Promise.all([
              runMetadataQuery(connectionId, q.schemasQuery),
              runMetadataQuery(connectionId, q.functionsQuery),
              runMetadataQuery(connectionId, q.tablesQuery),
              includeColumns
                ? runMetadataQuery(connectionId, q.columnsQuery)
                : Promise.resolve(null),
            ]);

          const schemas = (schemasRes.rows ?? [])
            .map((r: any) => cellToString(r?.[0]) ?? "")
            .filter(Boolean);
          setCache(metaKey, { schemas, progress: 10, stage: "functions" });

          const functions: FunctionItem[] = (functionsRes.rows ?? [])
            .map((r: any): FunctionItem => {
              const schema = cellToString(r?.[0]) ?? "";
              const name = cellToString(r?.[1]) ?? "";
              const args = cellToString(r?.[2]) ?? "";
              return { schema, name, args };
            })
            .filter((f: FunctionItem) => Boolean(f.schema && f.name));
          setCache(metaKey, { functions, progress: 20, stage: "tables" });

          const tables: TableItem[] = (tablesRes.rows ?? [])
            .map((r: any): TableItem => {
              const rawKind = cellToString(r?.[2])?.toUpperCase() ?? "";
              const kind: TableItem["kind"] =
                rawKind === "VIEW" ? "view" : "table";

              return {
                schema: cellToString(r?.[0]) ?? "",
                name: cellToString(r?.[1]) ?? "",
                kind,
              };
            })
            .filter((t: TableItem) => Boolean(t.schema && t.name));
          setCache(metaKey, { tables, progress: 35, stage: "columns" });

          let columnsByTable = existing?.columnsByTable ?? {};
          let columnsLoaded = existing?.columnsLoaded ?? false;

          if (includeColumns && colsRes) {
            const rows = colsRes.rows ?? [];
            columnsByTable = {};
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
                const prog = 35 + Math.floor((i / total) * 65);
                setCache(metaKey, { progress: Math.min(99, prog) });
              }
            }

            columnsLoaded = true;
          }

          setCache(metaKey, {
            columnsByTable,
            columnsLoaded,
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
    [runMetadataQuery]
  );

  const get = useCallback(
    (args: {
      metaKey: string;
      engine?: DatabaseEngine;
      lazy?: boolean;
      connectionId?: string;
      includeColumns?: boolean;
    }) => {
      const {
        metaKey,
        engine,
        lazy = true,
        connectionId,
        includeColumns = false,
      } = args;

      const meta = cacheRef.current[metaKey] ?? emptyMeta(engine);

      // Lazy load only if we have connectionId to execute queries
      if (
        lazy &&
        connectionId &&
        (!meta.loaded || (includeColumns && !meta.columnsLoaded)) &&
        !meta.loading &&
        !meta.error
      ) {
        void load({ metaKey, engine, connectionId, includeColumns });
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
      includeColumns?: boolean;
    }) => {
      const { metaKey, engine, connectionId, includeColumns = false } = args;
      invalidate({ metaKey });
      return await load({
        metaKey,
        engine,
        connectionId,
        force: true,
        includeColumns,
      });
    },
    [invalidate, load]
  );

  const clear = invalidate;

  return { get, load, refresh, invalidate, clear };
}

export type MetadataApi = ReturnType<typeof useDatabaseMetadata>;
