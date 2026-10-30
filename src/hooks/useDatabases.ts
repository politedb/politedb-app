import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { runtimeWorkIsCurrent } from "src/lib/runtimeConnection";
import { runSqlQuery } from "src/lib/tauri/query";
import type { DatabaseEngine } from "src/types";
import {
  createDatabaseQuery,
  dbListQuery,
  dropDatabaseQuery,
  isMySqlLike,
  renameDatabaseQuery,
} from "src/lib/queries/sql";
import { cellToString } from "src/utils/convert";
import { mongoListDatabases } from "src/lib/tauri/mongo";
import { cassandraListKeyspaces } from "src/lib/tauri/cassandra";

export type DatabaseEditorMode = null | "create" | "rename";

export function canManageDatabases(engine?: DatabaseEngine) {
  return (
    engine === "postgres" ||
    engine === "mongo" ||
    engine === "sqlserver" ||
    engine === "clickhouse" ||
    isMySqlLike(engine)
  );
}

/** Toolbar database icon: list/switch database or keyspace. */
export function canOpenDatabases(engine?: DatabaseEngine) {
  return canManageDatabases(engine) || engine === "cassandra";
}

interface UseDatabasesParams {
  open: boolean;
  engine?: DatabaseEngine;
  runtimeConnectionId?: string;
  onOpenDatabase?: (dbName: string) => Promise<void>;
  /** Checks around creating, renaming or dropping a database. */
  beforeChange?: (change: DatabaseChange) => DatabaseChangeCheck;
}

/**
 * Checks around a database change. Each returns why it may not happen
 * (shown as the error), or null to go ahead.
 */
export type DatabaseChangeCheck = {
  /** Waits that come first (Touch ID, closing tabs). */
  prepare: () => Promise<string | null>;
  /** Run with nothing awaited, right before the SQL is sent. */
  checkNow: () => string | null;
};

export type DatabaseChange =
  | { kind: "create"; name: string }
  | { kind: "rename"; name: string; to: string }
  | { kind: "drop"; name: string };

export function useDatabases({
  open,
  engine,
  runtimeConnectionId,
  onOpenDatabase,
  beforeChange,
}: UseDatabasesParams) {
  const [dbs, setDbs] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [selectedDb, setSelectedDb] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editorMode, setEditorMode] = useState<DatabaseEditorMode>(null);
  const [nameDraft, setNameDraft] = useState("");

  const visibleDbs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dbs;
    return dbs.filter((x) => x.toLowerCase().includes(q));
  }, [dbs, search]);

  const loadSeqRef = useRef(0);
  const loadDatabases = useCallback(async () => {
    if (!runtimeConnectionId || !canOpenDatabases(engine)) return;
    // Late results of an older list or connection never land (R5).
    const seq = ++loadSeqRef.current;
    const current = runtimeWorkIsCurrent(runtimeConnectionId);
    const mine = () => loadSeqRef.current === seq && current();
    setBusy(true);
    setError("");
    try {
      let list = [];

      if (engine === "mongo") {
        list = await mongoListDatabases(runtimeConnectionId);
      } else if (engine === "cassandra") {
        list = await cassandraListKeyspaces(runtimeConnectionId);
      } else {
        const res = await runSqlQuery(runtimeConnectionId, dbListQuery(engine));
        list = (res.rows ?? [])
          .map((r) => cellToString(r?.[0]) ?? "")
          .filter(Boolean);
      }

      if (mine()) setDbs(list);
    } catch (e) {
      if (mine()) {
        setError(String((e as any)?.message ?? e ?? "LOAD_DATABASES_FAILED"));
      }
    } finally {
      if (loadSeqRef.current === seq) setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeConnectionId, engine, selectedDb]);

  useEffect(() => {
    if (!open) return;
    setEditorMode(null);
    setNameDraft("");
    setSearch("");
    void loadDatabases();
  }, [open, loadDatabases]);

  const executeDbSql = useCallback(
    async (
      sql: string,
      change: DatabaseChange,
      describeError?: (message: string) => string
    ) => {
      if (!runtimeConnectionId) return false;
      setBusy(true);
      setError("");
      try {
        const check = beforeChange?.(change);
        const refused =
          (check ? await check.prepare() : null) ?? check?.checkNow() ?? null;
        if (refused) {
          setError(refused);
          return false;
        }
        // Sent in the same turn as checkNow: nothing can change in between.
        await runSqlQuery(runtimeConnectionId, sql);
        await loadDatabases();
        return true;
      } catch (e) {
        const message = String(
          (e as any)?.message ?? e ?? "DATABASE_ACTION_FAILED"
        );
        setError(describeError ? describeError(message) : message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [runtimeConnectionId, loadDatabases, beforeChange]
  );

  const onCreateDb = useCallback(() => {
    const next = nameDraft.trim();
    if (!next || !engine) return;
    void (async () => {
      const ok = await executeDbSql(createDatabaseQuery(next, engine), {
        kind: "create",
        name: next,
      });
      if (!ok) return;
      setEditorMode(null);
      setNameDraft("");
    })();
  }, [nameDraft, engine, executeDbSql]);

  const onRenameDb = useCallback(() => {
    const from = selectedDb.trim();
    const to = nameDraft.trim();
    if (!from || !to || !engine) return;
    void (async () => {
      const ok = await executeDbSql(renameDatabaseQuery(from, to, engine), {
        kind: "rename",
        name: from,
        to,
      });
      if (!ok) return;
      setEditorMode(null);
      setNameDraft("");
    })();
  }, [selectedDb, nameDraft, engine, executeDbSql]);

  const onDropDb = useCallback(() => {
    if (!selectedDb || !engine) return;
    void executeDbSql(dropDatabaseQuery(selectedDb, engine), {
      kind: "drop",
      name: selectedDb,
    });
  }, [selectedDb, engine, executeDbSql]);

  const onDropDbByName = useCallback(
    (dbName: string, describeError?: (message: string) => string) => {
      const name = dbName.trim();
      if (!name || !engine) return Promise.resolve(false);
      return executeDbSql(
        dropDatabaseQuery(name, engine),
        { kind: "drop", name },
        describeError
      );
    },
    [engine, executeDbSql]
  );

  const onOpenDb = useCallback(async () => {
    const dbName = selectedDb.trim();
    if (!dbName || !onOpenDatabase) return false;

    setBusy(true);
    setError("");
    try {
      await onOpenDatabase(dbName);
      return true;
    } catch (e) {
      setError(String((e as any)?.message ?? e ?? "OPEN_DATABASE_FAILED"));
      return false;
    } finally {
      setBusy(false);
    }
  }, [selectedDb, onOpenDatabase]);

  return {
    dbs,
    search,
    selectedDb,
    busy,
    error,
    editorMode,
    nameDraft,
    visibleDbs,
    setSearch,
    setError,
    setSelectedDb,
    setEditorMode,
    setNameDraft,
    loadDatabases,
    onCreateDb,
    onRenameDb,
    onDropDb,
    onDropDbByName,
    onOpenDb,
  };
}
