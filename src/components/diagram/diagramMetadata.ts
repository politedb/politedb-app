import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import {
  diagramSchemaMetadataQueries,
  diagramTableColumnsQuery,
  tableColumnsQuery,
  tableConstraintsMySqlQuery,
  tableConstraintsQuery,
  tableForeignKeysQuery,
} from "src/lib/queries/sql";
import { runSqlQuery } from "src/lib/tauri/query";
import type { DatabaseEngine, ForeignKeyInfo } from "src/types";
import { cellToString } from "src/utils/convert";
import { mapPool } from "src/utils/mapPool";
import type {
  DiagramColumn,
  DiagramRelation,
  DiagramState,
  DiagramTable,
} from "./diagramTypes";

const DIAGRAM_METADATA_CONCURRENCY = 8;

function sanitizeEntityName(name: string) {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function splitCsv(value: string | null | undefined) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function fkColumnSignature(columnNamesCsv: string): string {
  return splitCsv(columnNamesCsv)
    .map((column) => column.toLowerCase())
    .sort()
    .join("|");
}

function tableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

function cellIsTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = cellToString(value as never)
    ?.toLowerCase()
    .trim();
  return ["true", "t", "1", "yes"].includes(normalized ?? "");
}

function diagramConstraintsSql(
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
): string | null {
  if (
    !engine ||
    engine === "mongo" ||
    engine === "cassandra" ||
    engine === "redis"
  ) {
    return null;
  }
  if (engine === "mysql" || engine === "mariadb") {
    return tableConstraintsMySqlQuery(schema, tableName);
  }
  return tableConstraintsQuery(schema, tableName, engine);
}

function uniqueColumnSignatureFromConstraintRow(
  row: unknown[],
  engine?: DatabaseEngine
): string | null {
  let isUniqueLike = false;
  let columns = "";

  if (engine === "mysql" || engine === "mariadb") {
    const nonUnique = Number(cellToString(row?.[2]) ?? "1");
    const isPrimary = cellToString(row?.[3])?.toLowerCase() === "true";
    isUniqueLike = nonUnique === 0 || isPrimary;
    columns = cellToString(row?.[4]) ?? "";
  } else {
    isUniqueLike = cellIsTruthy(row?.[2]) || cellIsTruthy(row?.[3]);
    columns = cellToString(row?.[5]) ?? "";
  }

  return isUniqueLike ? fkColumnSignature(columns) : null;
}

function mapForeignKeyRows(rows: unknown[][]): ForeignKeyInfo[] {
  return rows
    .map((row) => ({
      constraint_name: cellToString(row?.[0]) ?? "",
      table_schema: cellToString(row?.[1]) ?? "",
      table_name: cellToString(row?.[2]) ?? "",
      column_names: cellToString(row?.[3]) ?? "",
      ref_table_schema: cellToString(row?.[4]) ?? "",
      ref_table_name: cellToString(row?.[5]) ?? "",
      ref_column_names: cellToString(row?.[6]) ?? "",
      on_update: cellToString(row?.[7]) ?? "",
      on_delete: cellToString(row?.[8]) ?? "",
    }))
    .filter((item) => item.table_name && item.ref_table_name);
}

function dedupeForeignKeys(foreignKeys: ForeignKeyInfo[]): ForeignKeyInfo[] {
  const seen = new Set<string>();
  return foreignKeys.filter((foreignKey) => {
    const key = [
      foreignKey.table_schema,
      foreignKey.table_name,
      foreignKey.column_names.trim().toLowerCase(),
      foreignKey.ref_table_schema,
      foreignKey.ref_table_name,
      foreignKey.ref_column_names.trim().toLowerCase(),
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildMermaid(
  schema: string,
  tables: DiagramTable[],
  foreignKeys: ForeignKeyInfo[]
) {
  const entityNameByTable = new Map<string, string>();
  const lines: string[] = [];

  for (const table of tables) {
    const key = tableKey(schema, table.name);
    const tableIdent = sanitizeEntityName(table.name);
    entityNameByTable.set(key, tableIdent);
    lines.push(`Table ${tableIdent} {`);
    if (table.columns.length === 0) {
      lines.push("  _empty varchar");
    } else {
      for (const column of table.columns) {
        const primary = column.isPrimaryKey ? " [primary key]" : "";
        lines.push(
          `  ${sanitizeEntityName(column.name)} ${column.type}${primary}`
        );
      }
    }
    lines.push("}", "");
  }

  const seenRelations = new Set<string>();
  for (const foreignKey of foreignKeys) {
    const child = entityNameByTable.get(
      tableKey(foreignKey.table_schema, foreignKey.table_name)
    );
    const parent = entityNameByTable.get(
      tableKey(foreignKey.ref_table_schema, foreignKey.ref_table_name)
    );
    if (!child || !parent) continue;

    const columns = splitCsv(foreignKey.column_names);
    const refColumns = splitCsv(foreignKey.ref_column_names);
    const pairCount = Math.max(columns.length, refColumns.length, 1);
    for (let index = 0; index < pairCount; index += 1) {
      const childColumn = columns[index] ?? columns[0] ?? "id";
      const parentColumn = refColumns[index] ?? refColumns[0] ?? "id";
      const relation = `Ref: ${child}.${sanitizeEntityName(childColumn)} > ${parent}.${sanitizeEntityName(parentColumn)}`;
      if (seenRelations.has(relation)) continue;
      seenRelations.add(relation);
      lines.push(relation);
    }
  }

  return lines.join("\n").trimEnd();
}

function buildRelations(
  foreignKeys: ForeignKeyInfo[],
  uniqueByChildTable: Map<string, Set<string>>
): DiagramRelation[] {
  return foreignKeys.map((foreignKey) => {
    const columns = splitCsv(foreignKey.column_names);
    const refColumns = splitCsv(foreignKey.ref_column_names);
    const uniqueColumns = uniqueByChildTable.get(
      tableKey(foreignKey.table_schema, foreignKey.table_name)
    );

    return {
      fromTable: tableKey(
        foreignKey.ref_table_schema,
        foreignKey.ref_table_name
      ),
      toTable: tableKey(foreignKey.table_schema, foreignKey.table_name),
      label: columns.join(", ") || foreignKey.constraint_name,
      fromColumn: refColumns[0],
      toColumn: columns[0],
      cardinality: uniqueColumns?.has(
        fkColumnSignature(foreignKey.column_names)
      )
        ? "one-to-one"
        : "one-to-many",
    };
  });
}

async function loadPerTableMetadata(args: {
  connectionId: string;
  engine: DatabaseEngine;
  schema: string;
  tableNames: string[];
}) {
  const { connectionId, engine, schema, tableNames } = args;
  return mapPool(
    tableNames,
    DIAGRAM_METADATA_CONCURRENCY,
    async (tableName) => {
      const primaryKeySql = diagramTableColumnsQuery(schema, tableName, engine);
      const columnsSql =
        primaryKeySql ?? tableColumnsQuery(schema, tableName, engine);
      const constraintsSql =
        engine === "mongo"
          ? null
          : diagramConstraintsSql(schema, tableName, engine);

      const [columnsResult, foreignKeysResult, constraintsResult] =
        await Promise.all([
          runSqlQuery(connectionId, columnsSql, { batchSize: 500 }),
          engine === "mongo"
            ? Promise.resolve(null)
            : runSqlQuery(
                connectionId,
                tableForeignKeysQuery(schema, tableName, engine),
                { batchSize: 200 }
              ),
          constraintsSql
            ? runSqlQuery(connectionId, constraintsSql, {
                batchSize: 400,
              }).catch(() => null)
            : Promise.resolve(null),
        ]);

      const columns: DiagramColumn[] = (columnsResult.rows ?? [])
        .map((row) => ({
          name: cellToString(row?.[0]) ?? "",
          type: cellToString(row?.[1]) ?? "",
          isPrimaryKey: primaryKeySql ? cellIsTruthy(row?.[2]) : false,
        }))
        .filter((column) => column.name);
      const uniqueSignatures = (constraintsResult?.rows ?? [])
        .map((row) =>
          uniqueColumnSignatureFromConstraintRow(row as unknown[], engine)
        )
        .filter((signature): signature is string => Boolean(signature));

      return {
        table: { schema, name: tableName, columns },
        foreignKeys:
          foreignKeysResult === null
            ? []
            : mapForeignKeyRows(foreignKeysResult.rows ?? []),
        uniqueSignatures,
      };
    }
  );
}

export async function loadDiagramState(args: {
  metadata: MetadataApi;
  metaKey: string;
  connectionId: string;
  engine: DatabaseEngine;
  schema: string;
}): Promise<DiagramState> {
  const { metadata, metaKey, connectionId, engine, schema } = args;
  let meta = await metadata.load({
    metaKey,
    engine,
    connectionId,
    includeColumns: true,
  });
  if (!meta.columnsLoaded) {
    meta = await metadata.load({
      metaKey,
      engine,
      connectionId,
      includeColumns: true,
    });
  }

  const tableNames = (meta.tables ?? [])
    .filter((table) => table.schema === schema)
    .map((table) => table.name);
  let tables: DiagramTable[];
  let foreignKeys: ForeignKeyInfo[];
  const uniqueByChildTable = new Map<string, Set<string>>();
  const batchQueries = diagramSchemaMetadataQueries(schema, engine);

  if (batchQueries) {
    const [foreignKeysResult, constraintsResult] = await Promise.all([
      runSqlQuery(connectionId, batchQueries.foreignKeys, { batchSize: 500 }),
      runSqlQuery(connectionId, batchQueries.uniqueConstraints, {
        batchSize: 500,
      }),
    ]);
    const primaryColumnsByTable = new Map<string, Set<string>>();

    for (const row of constraintsResult.rows ?? []) {
      const tableName = cellToString(row?.[0]) ?? "";
      const columns = splitCsv(cellToString(row?.[2]));
      if (!tableName || columns.length === 0) continue;
      const key = tableKey(schema, tableName);
      const uniqueColumns = uniqueByChildTable.get(key) ?? new Set<string>();
      uniqueColumns.add(fkColumnSignature(columns.join(",")));
      uniqueByChildTable.set(key, uniqueColumns);
      if (cellIsTruthy(row?.[1])) {
        primaryColumnsByTable.set(
          key,
          new Set(columns.map((column) => column.toLowerCase()))
        );
      }
    }

    tables = tableNames.map((tableName) => {
      const key = tableKey(schema, tableName);
      const details = meta.columnDetailsByTable?.[key] ?? [];
      const fallbackNames = meta.columnsByTable?.[key] ?? [];
      const primaryColumns = primaryColumnsByTable.get(key);
      const columns = (
        details.length > 0
          ? details.map((column) => ({
              name: column.name,
              type: column.dataType ?? "",
            }))
          : fallbackNames.map((name) => ({ name, type: "" }))
      ).map((column) => ({
        ...column,
        isPrimaryKey: primaryColumns?.has(column.name.toLowerCase()) ?? false,
      }));
      return { schema, name: tableName, columns };
    });
    foreignKeys = dedupeForeignKeys(
      mapForeignKeyRows(foreignKeysResult.rows ?? [])
    );
  } else {
    const loaded = await loadPerTableMetadata({
      connectionId,
      engine,
      schema,
      tableNames,
    });
    tables = loaded.map((item) => item.table);
    foreignKeys = dedupeForeignKeys(loaded.flatMap((item) => item.foreignKeys));
    for (const item of loaded) {
      if (item.uniqueSignatures.length > 0) {
        uniqueByChildTable.set(
          tableKey(schema, item.table.name),
          new Set(item.uniqueSignatures)
        );
      }
    }
  }

  const relations = buildRelations(foreignKeys, uniqueByChildTable);
  return {
    mermaid: buildMermaid(schema, tables, foreignKeys),
    tableCount: tables.length,
    relationshipCount: relations.length,
    tables,
    relations,
  };
}
