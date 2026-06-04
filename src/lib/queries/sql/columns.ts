import type { DatabaseEngine } from "src/types";
import { isMySqlLike, isSqlitePragmaEngine, qLiteral, regexEscape } from "./shared";

export const tableColumnsQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  if (isSqlitePragmaEngine(engine)) {
    const queryStr = `
      SELECT name AS column_name, type AS data_type
      FROM pragma_table_info(${qLiteral(tableName)})
      ORDER BY cid;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "oracle") {
    const queryStr = `
      SELECT column_name, data_type
      FROM all_tab_columns
      WHERE owner = ${qLiteral(schema.toUpperCase())}
        AND table_name = ${qLiteral(tableName.toUpperCase())}
      ORDER BY column_id;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "clickhouse") {
    const queryStr = `
      SELECT column_name, data_type, numeric_scale
      FROM information_schema.columns
      WHERE table_catalog = currentDatabase()
        AND table_schema = ${qLiteral(schema)}
        AND table_name = ${qLiteral(tableName)}
      ORDER BY ordinal_position;
    `;
    return regexEscape(queryStr);
  }

  const queryStr = `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = ${qLiteral(schema)}
      AND table_name = ${qLiteral(tableName)}
    ORDER BY ordinal_position;
  `;
  return regexEscape(queryStr);
};

/** Columns + primary-key flag for ER diagram (third column truthy = PK). Unsupported engines return null → caller falls back to `tableColumnsQuery`. */
export function diagramTableColumnsQuery(
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
): string | null {
  if (isSqlitePragmaEngine(engine)) {
    const queryStr = `
      SELECT name AS column_name, type AS data_type,
        CASE WHEN IFNULL(pk, 0) != 0 THEN 1 ELSE 0 END AS is_primary
      FROM pragma_table_info(${qLiteral(tableName)})
      ORDER BY cid;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "duckdb") {
    const queryStr = `
      SELECT
        c.column_name,
        c.data_type,
        CASE WHEN EXISTS (
          SELECT 1
          FROM duckdb_constraints() dc
          WHERE dc.constraint_type = 'PRIMARY KEY'
            AND dc.schema_name = ${qLiteral(schema)}
            AND dc.table_name = ${qLiteral(tableName)}
            AND list_contains(dc.constraint_column_names, c.column_name)
        ) THEN 1 ELSE 0 END AS is_primary
      FROM information_schema.columns c
      WHERE c.table_schema = ${qLiteral(schema)}
        AND c.table_name = ${qLiteral(tableName)}
      ORDER BY c.ordinal_position;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "snowflake") {
    const queryStr = `
      SELECT
        c.column_name,
        c.data_type,
        0 AS is_primary
      FROM information_schema.columns c
      WHERE c.table_schema = ${qLiteral(schema)}
        AND c.table_name = ${qLiteral(tableName)}
      ORDER BY c.ordinal_position;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "clickhouse") {
    const queryStr = `
      SELECT
        c.column_name,
        c.data_type,
        0 AS is_primary
      FROM information_schema.columns AS c
      WHERE c.table_catalog = currentDatabase()
        AND c.table_schema = ${qLiteral(schema)}
        AND c.table_name = ${qLiteral(tableName)}
      ORDER BY c.ordinal_position;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "postgres" || isMySqlLike(engine)) {
    const queryStr = `
      SELECT
        c.column_name,
        c.data_type,
        EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_schema = kcu.constraint_schema
           AND tc.constraint_name = kcu.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = c.table_schema
            AND tc.table_name = c.table_name
            AND kcu.column_name = c.column_name
        ) AS is_primary
      FROM information_schema.columns c
      WHERE c.table_schema = ${qLiteral(schema)}
        AND c.table_name = ${qLiteral(tableName)}
      ORDER BY c.ordinal_position;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "sqlserver") {
    const queryStr = `
      SELECT
        c.name AS column_name,
        ty.name AS data_type,
        CAST(CASE WHEN EXISTS (
          SELECT 1
          FROM sys.index_columns ic
          INNER JOIN sys.indexes i
            ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE ic.object_id = c.object_id
            AND ic.column_id = c.column_id
            AND i.is_primary_key = 1
        ) AS bit) AS is_primary
      FROM sys.columns c
      INNER JOIN sys.tables t ON t.object_id = c.object_id
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE s.name = ${qLiteral(schema)}
        AND t.name = ${qLiteral(tableName)}
      ORDER BY c.column_id;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "oracle") {
    const owner = schema.toUpperCase();
    const tbl = tableName.toUpperCase();
    const queryStr = `
      SELECT
        c.column_name,
        c.data_type,
        CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS is_primary
      FROM all_tab_columns c
      LEFT JOIN (
        SELECT acc.column_name
        FROM all_constraints ac
        JOIN all_cons_columns acc
          ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
        WHERE ac.constraint_type = 'P'
          AND ac.owner = ${qLiteral(owner)}
          AND ac.table_name = ${qLiteral(tbl)}
      ) pk ON pk.column_name = c.column_name
      WHERE c.owner = ${qLiteral(owner)}
        AND c.table_name = ${qLiteral(tbl)}
      ORDER BY c.column_id;
    `;
    return regexEscape(queryStr);
  }

  return null;
}
