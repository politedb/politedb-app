import type { DatabaseEngine } from "src/types";
import { isMySqlLike, qLiteral, regexEscape } from "./shared";

export const tableSizeInfoQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  // Cloudflare D1 / Turso remote have no dbstat virtual table (local SQLite only).
  if (engine === "d1" || engine === "turso") {
    const queryStr = `
      SELECT 0 AS total_size, 0 AS data_size, 0 AS index_size;
    `;
    return regexEscape(queryStr);
  }

  // DuckDB has no pg_catalog size views; per-table size via pragma is optional.
  if (engine === "duckdb") {
    const tableRef =
      schema && schema.toLowerCase() !== "main"
        ? `${schema}.${tableName}`
        : tableName;
    const queryStr = `
      WITH block_info AS (
        SELECT CAST(block_size AS BIGINT) AS block_size
        FROM pragma_database_size()
      ),
      table_storage AS (
        SELECT COUNT(DISTINCT block_id) AS used_blocks
        FROM pragma_storage_info(${qLiteral(tableRef)})
        WHERE persistent = TRUE AND block_id IS NOT NULL
      )
      SELECT
        COALESCE((SELECT block_size FROM block_info), 0) * COALESCE((SELECT used_blocks FROM table_storage), 0) AS total_size,
        COALESCE((SELECT block_size FROM block_info), 0) * COALESCE((SELECT used_blocks FROM table_storage), 0) AS data_size,
        0 AS index_size;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "sqlite") {
    const queryStr = `
      WITH table_pages AS (
        SELECT COALESCE(SUM(pgsize), 0) AS size_bytes
        FROM dbstat
        WHERE name = ${qLiteral(tableName)}
      ),
      index_pages AS (
        SELECT COALESCE(SUM(d.pgsize), 0) AS size_bytes
        FROM dbstat d
        WHERE d.name IN (
          SELECT name
          FROM pragma_index_list(${qLiteral(tableName)})
          WHERE name IS NOT NULL
        )
      )
      SELECT
        COALESCE((SELECT size_bytes FROM table_pages), 0) + COALESCE((SELECT size_bytes FROM index_pages), 0) AS total_size,
        COALESCE((SELECT size_bytes FROM table_pages), 0) AS data_size,
        COALESCE((SELECT size_bytes FROM index_pages), 0) AS index_size;
    `;
    return regexEscape(queryStr);
  }

  if (isMySqlLike(engine)) {
    const queryStr = `
      SELECT
        COALESCE(data_length, 0) + COALESCE(index_length, 0) AS total_size,
        COALESCE(data_length, 0) AS data_size,
        COALESCE(index_length, 0) AS index_size
      FROM information_schema.tables
      WHERE table_schema = ${qLiteral(schema)}
        AND table_name = ${qLiteral(tableName)}
      LIMIT 1;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "sqlserver") {
    const queryStr = `
      SELECT
        COALESCE(SUM(ps.reserved_page_count), 0) * 8192 AS total_size,
        COALESCE(SUM(ps.in_row_data_page_count + ps.lob_used_page_count + ps.row_overflow_used_page_count), 0) * 8192 AS data_size,
        COALESCE(SUM(ps.used_page_count - (ps.in_row_data_page_count + ps.lob_used_page_count + ps.row_overflow_used_page_count)), 0) * 8192 AS index_size
      FROM sys.dm_db_partition_stats ps
      INNER JOIN sys.objects o ON o.object_id = ps.object_id
      INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = ${qLiteral(schema)}
        AND o.name = ${qLiteral(tableName)}
        AND o.type = 'U';
    `;
    return regexEscape(queryStr);
  }

  if (engine === "snowflake") {
    // Size metadata is often unavailable for INFORMATION_SCHEMA or limited roles.
    if (schema.toUpperCase() === "INFORMATION_SCHEMA") {
      const queryStr = `
        SELECT 0 AS total_size, 0 AS data_size, 0 AS index_size;
      `;
      return regexEscape(queryStr);
    }
    const queryStr = `
      SELECT
        COALESCE(t.BYTES, 0) AS total_size,
        COALESCE(t.BYTES, 0) AS data_size,
        0 AS index_size
      FROM information_schema.tables t
      WHERE t.table_schema = ${qLiteral(schema)}
        AND t.table_name = ${qLiteral(tableName)}
      LIMIT 1;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "oracle") {
    const table = tableName.toUpperCase();
    const queryStr = `
      WITH table_segments AS (
        SELECT COALESCE(SUM(bytes), 0) AS data_size
        FROM user_segments
        WHERE segment_name = ${qLiteral(table)}
          AND segment_type IN (
            'TABLE',
            'TABLE PARTITION',
            'TABLE SUBPARTITION',
            'LOBSEGMENT',
            'LOB PARTITION',
            'LOB SUBPARTITION'
          )
      ),
      index_segments AS (
        SELECT COALESCE(SUM(s.bytes), 0) AS index_size
        FROM user_indexes i
        LEFT JOIN user_segments s
          ON s.segment_name = i.index_name
         AND s.segment_type LIKE 'INDEX%'
        WHERE i.table_name = ${qLiteral(table)}
      )
      SELECT
        COALESCE((SELECT data_size FROM table_segments), 0) + COALESCE((SELECT index_size FROM index_segments), 0) AS total_size,
        COALESCE((SELECT data_size FROM table_segments), 0) AS data_size,
        COALESCE((SELECT index_size FROM index_segments), 0) AS index_size
      FROM dual;
    `;
    return regexEscape(queryStr);
  }

  const queryStr = `
    SELECT
      pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
      pg_size_pretty(pg_table_size(relid)) AS data_size,
      pg_size_pretty(pg_indexes_size(relid)) AS index_size
    FROM
      pg_catalog.pg_statio_user_tables
    WHERE
      schemaname = ${qLiteral(schema)}
      AND relname = ${qLiteral(tableName)}
    UNION
    SELECT
      NULL AS total_size,
      NULL AS data_size,
      NULL AS index_size
    FROM
      pg_catalog.pg_proc p
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE
      n.nspname = ${qLiteral(schema)}
      AND p.proname = ${qLiteral(tableName)}
    UNION
    SELECT
      NULL AS total_size,
      NULL AS data_size,
      NULL AS index_size
    FROM
      pg_catalog.pg_class p
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
    WHERE
      n.nspname = ${qLiteral(schema)}
      AND p.relname = ${qLiteral(tableName)}
      AND p.relkind = 'v';
  `;
  return regexEscape(queryStr);
};
