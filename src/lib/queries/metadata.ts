import type { DatabaseEngine } from "src/types";

export type MetadataQueries = {
  schemasQuery: string;
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
    WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    ORDER BY schema_name;
  `,
  tablesQuery: `
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN (
      'information_schema',
      'mysql',
      'performance_schema',
      'sys'
    )
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_type, table_name;
  `,
  columnsQuery: `
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
    ORDER BY table_schema, table_name, ordinal_position;
  `,
};

const SQLITE: MetadataQueries = {
  // SQLite: treat "main" as schema
  schemasQuery: `
    SELECT 'main' AS schema_name;
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

// Engines without relational schema/tables
const EMPTY: MetadataQueries = {
  schemasQuery: `SELECT '' WHERE 1=0;`,
  tablesQuery: `SELECT '' WHERE 1=0;`,
  columnsQuery: `SELECT '' WHERE 1=0;`,
};

export function getMetadataQueries(engine?: DatabaseEngine): MetadataQueries {
  switch (engine) {
    case "postgres":
      return PG;
    case "mysql":
      return MYSQL;
    case "sqlite":
      return SQLITE;

    // not supported for table/column completion
    case "redis":
    default:
      return EMPTY;
  }
}
