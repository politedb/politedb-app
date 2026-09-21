import { useEffect, useRef, useState } from "preact/hooks";
import { loadDatabaseObjectDefinition } from "src/lib/databaseObjects";
import type { DatabaseEngine, DatabaseObjectItem } from "src/types";

export function useLoadDbObjectDefinition(args: {
  selectedObject: DatabaseObjectItem | null;
  isCreateMode: boolean;
  engine: DatabaseEngine;
  connectionId?: string;
}) {
  const { selectedObject, isCreateMode, engine, connectionId } = args;
  const [sql, setSql] = useState("");
  const [baselineSql, setBaselineSql] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const selectedObjectRef = useRef(selectedObject);
  selectedObjectRef.current = selectedObject;

  const selectedId = selectedObject?.id ?? null;

  useEffect(() => {
    if (isCreateMode || !selectedId) {
      requestSeqRef.current += 1;
      setLoading(false);
      setLoadError(null);
      if (!isCreateMode) {
        setSql("");
        setBaselineSql("");
      }
      return;
    }

    const item = selectedObjectRef.current;
    if (!connectionId || !item?.capability.canReadDefinition) {
      requestSeqRef.current += 1;
      setLoading(false);
      setSql("");
      setBaselineSql("");
      setLoadError(null);
      return;
    }

    const seq = ++requestSeqRef.current;
    setLoading(true);
    setSql("");
    setBaselineSql("");
    setLoadError(null);

    void loadDatabaseObjectDefinition({
      engine,
      connectionId,
      item,
    })
      .then((result) => {
        if (requestSeqRef.current !== seq) return;
        setSql(result.sql);
        setBaselineSql(result.sql);
      })
      .catch((err) => {
        if (requestSeqRef.current !== seq) return;
        setSql("");
        setBaselineSql("");
        setLoadError(err instanceof Error ? err.message : String(err ?? ""));
      })
      .finally(() => {
        if (requestSeqRef.current === seq) {
          setLoading(false);
        }
      });
  }, [selectedId, isCreateMode, engine, connectionId]);

  return { sql, setSql, baselineSql, setBaselineSql, loading, loadError };
}
