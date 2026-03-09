import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { runSqlQuery } from "src/lib/tauri/query";
import type { DatabaseEngine } from "src/types";
import {
  createDatabaseQuery,
  dbListQuery,
  dropDatabaseQuery,
  isMySqlLike,
  renameDatabaseQuery,
} from "./queries";
import { cellToString } from "src/utils/convert";

export type DatabaseEditorMode = null | "create" | "rename";

export function canManageDatabases(engine?: DatabaseEngine) {
  return engine === "postgres" || isMySqlLike(engine);
}

interface UseDatabasesParams {
  open: boolean;
  engine?: DatabaseEngine;
  runtimeConnectionId?: string;
  onOpenDatabase?: (dbName: string) => Promise<void>;
}

export function useDatabases({
  open,
  engine,
  runtimeConnectionId,
  onOpenDatabase,
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

  const loadDatabases = useCallback(async () => {
    if (!runtimeConnectionId || !canManageDatabases(engine)) return;
    setBusy(true);
    setError("");
    try {
      const res = await runSqlQuery(runtimeConnectionId, dbListQuery(engine));
      const list = (res.rows ?? [])
        .map((r) => cellToString(r?.[0]) ?? "")
        .filter(Boolean);
      setDbs(list);
      if (!selectedDb || !list.includes(selectedDb)) {
        setSelectedDb(list[0] ?? "");
      }
    } catch (e) {
      setError(String((e as any)?.message ?? e ?? "LOAD_DATABASES_FAILED"));
    } finally {
      setBusy(false);
    }
  }, [runtimeConnectionId, engine, selectedDb]);

  useEffect(() => {
    if (!open) return;
    setEditorMode(null);
    setNameDraft("");
    setSearch("");
    void loadDatabases();
  }, [open, loadDatabases]);

  const executeDbSql = useCallback(
    async (sql: string) => {
      if (!runtimeConnectionId) return false;
      setBusy(true);
      setError("");
      try {
        await runSqlQuery(runtimeConnectionId, sql);
        await loadDatabases();
        return true;
      } catch (e) {
        setError(String((e as any)?.message ?? e ?? "DATABASE_ACTION_FAILED"));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [runtimeConnectionId, loadDatabases]
  );

  const onCreateDb = useCallback(() => {
    const next = nameDraft.trim();
    if (!next || !engine) return;
    void (async () => {
      const ok = await executeDbSql(createDatabaseQuery(next, engine));
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
      const ok = await executeDbSql(renameDatabaseQuery(from, to, engine));
      if (!ok) return;
      setEditorMode(null);
      setNameDraft("");
    })();
  }, [selectedDb, nameDraft, engine, executeDbSql]);

  const onDropDb = useCallback(() => {
    if (!selectedDb || !engine) return;
    void executeDbSql(dropDatabaseQuery(selectedDb, engine));
  }, [selectedDb, engine, executeDbSql]);

  const onDropDbByName = useCallback(
    (dbName: string) => {
      const name = dbName.trim();
      if (!name || !engine) return;
      void executeDbSql(dropDatabaseQuery(name, engine));
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
