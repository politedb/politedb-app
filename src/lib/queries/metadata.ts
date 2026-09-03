import type { DatabaseEngine } from "src/types";

export type MetadataQueries = {
  schemasQuery: string;
  routinesQuery: string;
  triggersQuery: string;
  tablesQuery: string;
  columnsQuery: string;
};

const PG: MetadataQueries = {
  schemasQuery: `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name <> 'information_schema'
      AND schema_name !~ '^pg_'
    ORDER BY schema_name;
  `,
  routinesQuery: `
    SELECT
      n.nspname AS object_schema,
      p.proname AS object_name,
      CASE
        WHEN p.prokind = 'p' THEN 'procedure'
        ELSE 'function'
      END AS object_kind,
      pg_get_function_identity_arguments(p.oid) AS object_signature,
      '' AS table_name,
      '' AS enabled
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
      AND p.prokind IN ('f', 'p')
    ORDER BY n.nspname, p.proname;
  `,
  triggersQuery: `
    SELECT
      n.nspname AS object_schema,
      t.tgname AS object_name,
      'trigger' AS object_kind,
      '' AS object_signature,
      c.relname AS table_name,
      CASE
        WHEN t.tgenabled IN ('O', 'A') THEN 'true'
        ELSE 'false'
      END AS enabled
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname <> 'information_schema'
      AND n.nspname !~ '^pg_'
    ORDER BY n.nspname, c.relname, t.tgname;
  `,
  tablesQuery: `
    WITH RECURSIVE visible_relations AS (
      SELECT c.oid, c.relname, c.relkind, c.relowner, c.relnamespace
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema'
        AND n.nspname !~ '^pg_'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ),
    relation_tree AS (
      SELECT c.oid AS root_oid, c.oid AS rel_oid
      FROM visible_relations c
      WHERE c.relkind IN ('r', 'p', 'm')

      UNION

      SELECT tree.root_oid, inheritance.inhrelid
      FROM relation_tree tree
      JOIN pg_inherits inheritance ON inheritance.inhparent = tree.rel_oid
    ),
    relation_stats AS (
      SELECT
        tree.root_oid,
        CASE
          WHEN bool_or(
            relation.relkind <> 'p' AND relation.reltuples < 0
          ) THEN NULL
          ELSE COALESCE(
            SUM(relation.reltuples) FILTER (WHERE relation.relkind <> 'p'),
            0
          )::bigint
        END AS estimated_row,
        SUM(pg_total_relation_size(tree.rel_oid)) AS total_size,
        SUM(pg_table_size(tree.rel_oid)) AS data_size,
        SUM(pg_indexes_size(tree.rel_oid)) AS index_size
      FROM relation_tree tree
      JOIN pg_class relation ON relation.oid = tree.rel_oid
      GROUP BY tree.root_oid
    )
    SELECT
      n.nspname AS table_schema,
      c.relname AS table_name,
      CASE
        WHEN c.relkind IN ('v', 'm') THEN 'VIEW'
        ELSE 'BASE TABLE'
      END AS table_type,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner,
      stats.estimated_row,
      stats.total_size,
      stats.data_size,
      stats.index_size,
      COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
    FROM visible_relations c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN relation_stats stats ON stats.root_oid = c.oid
    ORDER BY n.nspname, c.relkind, c.relname;
  `,
  columnsQuery: `
    SELECT table_schema, table_name, column_name, data_type, is_nullable,
           COALESCE(column_default, ''), '' AS column_comment
    FROM information_schema.columns
    WHERE table_schema <> 'information_schema'
      AND table_schema !~ '^pg_'
    ORDER BY table_schema, table_name, ordinal_position;
  `,
};

const MYSQL: MetadataQueries = {
  schemasQuery: `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name = DATABASE()
    ORDER BY schema_name;
  `,
  routinesQuery: `
    SELECT
      routine_schema AS object_schema,
      routine_name AS object_name,
      LOWER(routine_type) AS object_kind,
      '' AS object_signature,
      '' AS table_name,
      '' AS enabled
    FROM information_schema.routines
    WHERE routine_schema = DATABASE()
      AND routine_type IN ('FUNCTION', 'PROCEDURE')
    ORDER BY routine_schema, routine_name;
  `,
  triggersQuery: `
    SELECT
      trigger_schema AS object_schema,
      trigger_name AS object_name,
      'trigger' AS object_kind,
      '' AS object_signature,
      event_object_table AS table_name,
      '' AS enabled
    FROM information_schema.triggers
    WHERE trigger_schema = DATABASE()
    ORDER BY trigger_schema, event_object_table, trigger_name;
  `,
  tablesQuery: `
    SELECT
      table_schema,
      table_name,
      table_type,
      '' AS owner,
      table_rows AS estimated_row,
      CASE
        WHEN data_length + index_length IS NULL THEN ''
        WHEN data_length + index_length < 1024 THEN CONCAT(data_length + index_length, ' B')
        WHEN data_length + index_length < 1048576 THEN CONCAT(ROUND((data_length + index_length) / 1024, 1), ' KB')
        WHEN data_length + index_length < 1073741824 THEN CONCAT(ROUND((data_length + index_length) / 1048576, 1), ' MB')
        ELSE CONCAT(ROUND((data_length + index_length) / 1073741824, 1), ' GB')
      END AS total_size,
      CASE
        WHEN data_length IS NULL THEN ''
        WHEN data_length < 1024 THEN CONCAT(data_length, ' B')
        WHEN data_length < 1048576 THEN CONCAT(ROUND(data_length / 1024, 1), ' KB')
        WHEN data_length < 1073741824 THEN CONCAT(ROUND(data_length / 1048576, 1), ' MB')
        ELSE CONCAT(ROUND(data_length / 1073741824, 1), ' GB')
      END AS data_size,
      CASE
        WHEN index_length IS NULL THEN ''
        WHEN index_length < 1024 THEN CONCAT(index_length, ' B')
        WHEN index_length < 1048576 THEN CONCAT(ROUND(index_length / 1024, 1), ' KB')
        WHEN index_length < 1073741824 THEN CONCAT(ROUND(index_length / 1048576, 1), ' MB')
        ELSE CONCAT(ROUND(index_length / 1073741824, 1), ' GB')
      END AS index_size,
      COALESCE(table_comment, '') AS comment
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_type, table_name;
  `,
  columnsQuery: `
    SELECT table_schema, table_name, column_name, column_type, is_nullable,
           COALESCE(column_default, ''), COALESCE(column_comment, '')
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
    ORDER BY table_schema, table_name, ordinal_position;
  `,
};

const SQLITE: MetadataQueries = {
  // SQLite: treat "main" as schema
  schemasQuery: `
    SELECT 'main' AS schema_name;
  `,
  routinesQuery: `
    SELECT '' WHERE 1=0;
  `,
  triggersQuery: `
    SELECT
      'main' AS object_schema,
      name AS object_name,
      'trigger' AS object_kind,
      '' AS object_signature,
      tbl_name AS table_name,
      'true' AS enabled
    FROM sqlite_master
    WHERE type='trigger'
    ORDER BY tbl_name, name;
  `,
  tablesQuery: `
    SELECT
      'main' AS table_schema,
      name AS table_name
    FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name;
  `,
  columnsQuery: `
    SELECT
      'main' AS table_schema,
      m.name AS table_name,
      p.name AS column_name,
      p.type AS data_type,
      CASE WHEN p."notnull" = 0 THEN 'YES' ELSE 'NO' END AS is_nullable,
      COALESCE(p.dflt_value, '') AS column_default,
      '' AS column_comment
    FROM sqlite_master m
    JOIN pragma_table_info(m.name) p
    WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.name, p.cid;
  `,
};

/** D1: same table discovery as SQLite; hide Cloudflare internal tables. */
const D1: MetadataQueries = {
  ...SQLITE,
  tablesQuery: `
    SELECT
      'main' AS table_schema,
      name AS table_name
    FROM sqlite_master
    WHERE type='table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT GLOB '_cf_*'
    ORDER BY name;
  `,
  columnsQuery: `SELECT '' WHERE 1=0;`,
};

const ORACLE: MetadataQueries = {
  schemasQuery: `
    SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS schema_name
    FROM dual;
  `,
  routinesQuery: `
    SELECT
      owner AS object_schema,
      object_name AS object_name,
      'function' AS object_kind,
      '' AS object_signature,
      '' AS table_name,
      '' AS enabled
    FROM all_procedures
    WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
      AND object_type = 'FUNCTION'
    ORDER BY owner, object_name;
  `,
  triggersQuery: `SELECT '' WHERE 1=0;`,
  tablesQuery: `
    SELECT
      owner AS table_schema,
      table_name,
      'BASE TABLE' AS table_type
    FROM all_tables
    WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
    ORDER BY owner, table_name;
  `,
  columnsQuery: `
    SELECT
      owner AS table_schema,
      table_name,
      column_name,
      data_type,
      nullable AS is_nullable,
      COALESCE(data_default, '') AS column_default,
      COALESCE(comments, '') AS column_comment
    FROM all_tab_columns
    LEFT JOIN all_col_comments USING (owner, table_name, column_name)
    WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
    ORDER BY owner, table_name, column_id;
  `,
};

const CLICKHOUSE: MetadataQueries = {
  schemasQuery: `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE catalog_name = currentDatabase()
    ORDER BY schema_name
  `,
  routinesQuery: `SELECT '' WHERE 1=0`,
  triggersQuery: `SELECT '' WHERE 1=0`,
  tablesQuery: `
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_catalog = currentDatabase()
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_name
  `,
  columnsQuery: `
    SELECT table_schema, table_name, column_name, data_type, is_nullable,
           COALESCE(column_default, ''), '' AS column_comment
    FROM information_schema.columns
    WHERE table_catalog = currentDatabase()
    ORDER BY table_schema, table_name, ordinal_position
  `,
};

const SNOWFLAKE: MetadataQueries = {
  schemasQuery: `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE catalog_name = CURRENT_DATABASE()
    ORDER BY schema_name;
  `,
  routinesQuery: `SELECT '' WHERE 1=0;`,
  triggersQuery: `SELECT '' WHERE 1=0;`,
  tablesQuery: `
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_catalog = CURRENT_DATABASE()
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_type, table_name;
  `,
  columnsQuery: `
    SELECT table_schema, table_name, column_name, data_type, is_nullable,
           COALESCE(column_default, ''), COALESCE(comment, '')
    FROM information_schema.columns
    WHERE table_catalog = CURRENT_DATABASE()
    ORDER BY table_schema, table_name, ordinal_position;
  `,
};

const SQLSERVER: MetadataQueries = {
  schemasQuery: `
    SELECT name AS schema_name
    FROM sys.schemas
    WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA')
    ORDER BY name;
  `,
  routinesQuery: `
    SELECT
      ROUTINE_SCHEMA AS object_schema,
      ROUTINE_NAME AS object_name,
      'function' AS object_kind,
      '' AS object_signature,
      '' AS table_name,
      '' AS enabled
    FROM INFORMATION_SCHEMA.ROUTINES
    WHERE ROUTINE_TYPE = 'FUNCTION'
    ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME;
  `,
  triggersQuery: `SELECT '' WHERE 1=0;`,
  tablesQuery: `
    SELECT
      TABLE_SCHEMA AS table_schema,
      TABLE_NAME AS table_name,
      TABLE_TYPE AS table_type
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
    ORDER BY TABLE_SCHEMA, TABLE_TYPE, TABLE_NAME;
  `,
  columnsQuery: `
    SELECT
      TABLE_SCHEMA AS table_schema,
      TABLE_NAME AS table_name,
      COLUMN_NAME AS column_name,
      DATA_TYPE AS data_type,
      IS_NULLABLE AS is_nullable,
      COALESCE(COLUMN_DEFAULT, '') AS column_default,
      '' AS column_comment
    FROM INFORMATION_SCHEMA.COLUMNS
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION;
  `,
};

// Engines without relational schema/tables
const EMPTY: MetadataQueries = {
  schemasQuery: `SELECT '' WHERE 1=0;`,
  routinesQuery: `SELECT '' WHERE 1=0;`,
  triggersQuery: `SELECT '' WHERE 1=0;`,
  tablesQuery: `SELECT '' WHERE 1=0;`,
  columnsQuery: `SELECT '' WHERE 1=0;`,
};

export function getMetadataQueries(engine?: DatabaseEngine): MetadataQueries {
  switch (engine) {
    case "postgres":
      return PG;
    case "mysql":
    case "mariadb":
      return MYSQL;
    case "sqlite":
    case "duckdb":
      return SQLITE;
    case "d1":
    case "turso":
      return D1;
    case "oracle":
      return ORACLE;
    case "sqlserver":
      return SQLSERVER;
    case "snowflake":
      return SNOWFLAKE;
    case "clickhouse":
      return CLICKHOUSE;

    // not supported for table/column completion
    case "redis":
    case "mongo":
    case "cassandra":
    default:
      return EMPTY;
  }
}
