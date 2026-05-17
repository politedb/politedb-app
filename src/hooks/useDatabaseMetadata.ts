import { useCallback, useRef, useState } from "preact/hooks";
import type { DatabaseEngine, TableItem } from "src/types";
import { runSqlQuery } from "src/lib/tauri/query";
import {
  connectionVersion,
  mongoCollectionOverview,
  mongoListCollections,
  mongoListDatabases,
  runRedisCommand,
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
  version: string;

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
    version: "",
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
        version: force ? "" : (existing?.version ?? ""),
        loading: true,
        loaded: false,
        error: null,
        progress: 0,
        stage: "schemas",
      });

      const p = (async (): Promise<DbMetadata> => {
        try {
          const version = await connectionVersion(connectionId);

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
              version: (version ?? "").trim(),
              loading: false,
              loaded: true,
              error: null,
              progress: 100,
              stage: "done",
            });

            return cacheRef.current[metaKey]!;
          }

          if (engine === "redis") {
            const schema = "db 0";
            setCache(metaKey, {
              schemas: [schema],
              functions: [],
              progress: 20,
              stage: "tables",
            });

            const scanRes = await runRedisCommand(connectionId, "SCAN", [], {
              batchSize: 500,
              maxRows: 5000,
              pattern: "*",
              scanCount: 1000,
              timeoutMs: 30_000,
            });

            const tables: TableItem[] = (scanRes.rows ?? [])
              .map((row: any) => ({
                schema,
                name: cellToString(row?.[0]) ?? "",
                kind: "table" as const,
              }))
              .filter((item) => Boolean(item.name));

            const columnsByTable = Object.fromEntries(
              tables.map((item) => [`${item.schema}.${item.name}`, ["value"]])
            );

            setCache(metaKey, {
              functions: [],
              tables,
              columnsByTable,
              columnsLoaded: true,
              version: (version ?? "").trim(),
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
            version: (version ?? "").trim(),
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

      // Lazy load when connected. Do not auto-retry on error — that retriggers on
      // every render and can pin the UI in a perpetual "connecting" state.
      const needsLoad =
        !meta.loaded || (includeColumns && !meta.columnsLoaded);

      if (lazy && connectionId && needsLoad && !meta.loading && !meta.error) {
        void load({
          metaKey,
          engine,
          connectionId,
          includeColumns,
        });
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
