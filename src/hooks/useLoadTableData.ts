import { useCallback, useState } from "preact/hooks";
import { connectionCreate, listenOp, operationExecute } from "../lib/tauri";
import type { ColumnMeta, TableChunk } from "../lib/tauri/types";
import { cellToString } from "../utils/convert";

export type TableData = {
  columns: ColumnMeta[];
  rows: any[][];
  rowCount: number;
};


type TableDataState = {
  [key: string]: {
    data: TableData | null;
    busy: boolean;
    error: string | null;
  };
};

export function useLoadTableData() {
  const [tableDataMap, setTableDataMap] = useState<TableDataState>({});
  const [connectionId, setConnectionId] = useState<string | null>(null);

  const getTableKey = (schema: string, tableName: string) => `${schema}.${tableName}`;

  const loadTableData = useCallback(
    async (connectionData: any, schema: string, tableName: string) => {
      const tableKey = getTableKey(schema, tableName);

      // Initialize state for this table
      setTableDataMap((prev) => ({
        ...prev,
        [tableKey]: { data: null, busy: true, error: null },
      }));

      try {
        // Create connection if needed
        let connId = connectionId;
        if (!connId) {
          const res = await connectionCreate(connectionData);
          connId = res.id;
          setConnectionId(connId);
        }

        // First, load column information from information_schema
        const columnsSql = `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${tableName}' ORDER BY ordinal_position`;
        const columnsOpId = await operationExecute({
          connection_id: connId,
          kind: "sql_query",
          sql: { sql: columnsSql, batch_size: 100, max_rows: 1000 },
        });

        const columns: ColumnMeta[] = [];
        const columnsBuffer: any[][] = [];

        // Load columns first
        await new Promise<void>((resolve, reject) => {
          const unsub = listenOp(
            columnsOpId,
            (chunk: TableChunk) => {
              if (chunk.rows && chunk.rows.length > 0) {
                columnsBuffer.push(...chunk.rows);
              }
            },
            () => {
              columns.push(
                ...columnsBuffer.map((row) => ({
                  name: cellToString(row[0]),
                  db_type: cellToString(row[1]),
                }))
              );
              unsub();
              resolve();
            },
            (err) => {
              unsub();
              reject(err);
            }
          );
        });

        // Then query table data
        const sql = `SELECT * FROM "${schema}"."${tableName}" LIMIT 1000`;
        const opId = await operationExecute({
          connection_id: connId,
          kind: "sql_query",
          sql: { sql, batch_size: 100, max_rows: 1000 },
        });

        const rows: any[][] = [];

        const unsub = listenOp(
          opId,
          (chunk: TableChunk) => {
            // Rows come in chunks
            if (chunk.rows && chunk.rows.length > 0) {
              rows.push(...chunk.rows);
            }
          },
          (done) => {
            setTableDataMap((prev) => ({
              ...prev,
              [tableKey]: {
                data: {
                  columns: columns,
                  rows,
                  rowCount: done.row_count,
                },
                busy: false,
                error: null,
              },
            }));
            unsub();
          },
          (err) => {
            setTableDataMap((prev) => ({
              ...prev,
              [tableKey]: {
                data: null,
                busy: false,
                error: err?.error || JSON.stringify(err),
              },
            }));
            unsub();
          }
        );
      } catch (e: any) {
        setTableDataMap((prev) => ({
          ...prev,
          [tableKey]: {
            data: null,
            busy: false,
            error: e?.message ? String(e.message) : String(e),
          },
        }));
      }
    },
    [connectionId]
  );

  const getTableData = (schema: string, tableName: string) => {
    const tableKey = getTableKey(schema, tableName);
    return tableDataMap[tableKey] || { data: null, busy: false, error: null };
  };

  const removeTableData = (schema: string, tableName: string) => {
    const tableKey = getTableKey(schema, tableName);
    setTableDataMap((prev) => {
      const newMap = { ...prev };
      delete newMap[tableKey];
      return newMap;
    });
  };

  return {
    loadTableData,
    getTableData,
    removeTableData,
  };
}
