import type { DatabaseEngine } from "src/types";

export type MetadataQueries = {
  schemasQuery: string;
  functionsQuery: string;
  tablesQuery: string;
  columnsQuery: string;
};

const PG: MetadataQueries = {
  schemasQuery: `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schema_name;
  `,
  functionsQuery: `
    SELECT
      n.nspname AS function_schema,
      p.proname AS function_name,
      pg_get_function_identity_arguments(p.oid) AS function_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, p.proname;
  `,
  tablesQuery: `
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_type, table_name;
  `,
  columnsQuery: `
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
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
  functionsQuery: `
    SELECT
      routine_schema AS function_schema,
      routine_name AS function_name,
      '' AS function_args
    FROM information_schema.routines
    WHERE routine_schema = DATABASE()
      AND routine_type = 'FUNCTION'
    ORDER BY routine_schema, routine_name;
  `,
  tablesQuery: `
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_type, table_name;
  `,
  columnsQuery: `
    SELECT table_schema, table_name, column_name
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
  functionsQuery: `
    SELECT '' WHERE 1=0;
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
      p.name AS column_name
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
  functionsQuery: `
    SELECT
      owner AS function_schema,
      object_name AS function_name,
      '' AS function_args
    FROM all_procedures
    WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
      AND object_type = 'FUNCTION'
    ORDER BY owner, object_name;
  `,
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
      column_name
    FROM all_tab_columns
    WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
    ORDER BY owner, table_name, column_id;
  `,
};

const SNOWFLAKE: MetadataQueries = {
  schemasQuery: `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE catalog_name = CURRENT_DATABASE()
    ORDER BY schema_name;
  `,
  functionsQuery: `SELECT '' WHERE 1=0;`,
  tablesQuery: `
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_catalog = CURRENT_DATABASE()
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_type, table_name;
  `,
  columnsQuery: `
    SELECT table_schema, table_name, column_name
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
  functionsQuery: `
    SELECT
      ROUTINE_SCHEMA AS function_schema,
      ROUTINE_NAME AS function_name,
      '' AS function_args
    FROM INFORMATION_SCHEMA.ROUTINES
    WHERE ROUTINE_TYPE = 'FUNCTION'
    ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME;
  `,
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
      COLUMN_NAME AS column_name
    FROM INFORMATION_SCHEMA.COLUMNS
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION;
  `,
};

// Engines without relational schema/tables
const EMPTY: MetadataQueries = {
  schemasQuery: `SELECT '' WHERE 1=0;`,
  functionsQuery: `SELECT '' WHERE 1=0;`,
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
      return D1;
    case "oracle":
      return ORACLE;
    case "sqlserver":
      return SQLSERVER;
    case "snowflake":
      return SNOWFLAKE;

    // not supported for table/column completion
    case "redis":
    default:
      return EMPTY;
  }
}
