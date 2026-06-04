import type { DatabaseEngine, TableColumn } from "src/types";
import {
  cloneTableSql,
  copyTableDataSql,
  createTableSql,
  dropTableSql,
  truncateTableSql,
} from "src/utils/sqlDialect";
import { isMySqlLike, qIdent, qLiteral, regexEscape } from "./shared";

export const createTableQuery = (
  schema: string,
  tableName: string,
  columns: TableColumn[],
  primaryKey: string | string[],
  engine?: DatabaseEngine
) => {
  const columnDefinitions = columns.map((col) => {
    let def = `${qIdent(col.column_name, engine)} ${col.data_type}`;

    // Add NOT NULL constraint if specified
    if (col.is_nullable === "NOT NULL") {
      def += " NOT NULL";
    }

    // Add default value if specified
    if (col.column_default && col.column_default.trim() !== "") {
      const defaultVal = col.column_default.trim();
      // If it's a function call or special value, use as-is, otherwise quote it
      if (
        defaultVal.match(/^[A-Z_][A-Z0-9_]*\(\)$/) || // Function calls like NOW()
        defaultVal.match(/^[0-9]+$/) || // Numbers
        defaultVal.toUpperCase() === "NULL"
      ) {
        def += ` DEFAULT ${defaultVal}`;
      } else {
        def += ` DEFAULT ${qLiteral(defaultVal, engine)}`;
      }
    }

    return def;
  });

  // Add PRIMARY KEY constraint (support single or multiple columns)
  const primaryKeyColumns = Array.isArray(primaryKey)
    ? primaryKey.filter(Boolean)
    : primaryKey
      ? [primaryKey]
      : [];
  const queryStr = createTableSql(
    schema,
    tableName,
    columnDefinitions,
    primaryKeyColumns,
    engine
  );
  return regexEscape(queryStr);
};

export const createSchemaQuery = (schema: string) => {
  const queryStr = `CREATE SCHEMA ${qIdent(schema)};`;
  return regexEscape(queryStr);
};

export const copyTableDataQuery = (
  schema: string,
  tableName: string,
  newTableName: string,
  engine?: DatabaseEngine
) => {
  const queryStr = copyTableDataSql(schema, tableName, newTableName, engine);
  return regexEscape(queryStr);
};

export const cloneTableQuery = (
  schema: string,
  tableName: string,
  newTableName: string,
  engine?: DatabaseEngine
) => {
  const queryStr = cloneTableSql(schema, tableName, newTableName, engine);
  return regexEscape(queryStr);
};

export const dropTableQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  const queryStr = dropTableSql(schema, tableName, engine);
  return regexEscape(queryStr);
};

export const truncateTableQuery = (
  schema: string,
  tableName: string,
  opts?: { restartIdentity?: boolean; cascade?: boolean },
  engine?: DatabaseEngine
) => {
  const queryStr = truncateTableSql(schema, tableName, opts, engine);
  return regexEscape(queryStr);
};

export const dbListQuery = (engine?: DatabaseEngine) => {
  if (isMySqlLike(engine)) {
    return "SELECT schema_name FROM information_schema.schemata WHERE schema_name = DATABASE() ORDER BY schema_name;";
  }
  if (engine === "sqlserver") {
    return "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name;";
  }
  if (engine === "snowflake") {
    return "SHOW DATABASES;";
  }
  if (engine === "clickhouse") {
    return `
      SELECT name
      FROM system.databases
      WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
      ORDER BY name
    `;
  }
  return "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;";
};

export const createDatabaseQuery = (
  database: string,
  engine?: DatabaseEngine
) => {
  const queryStr = `CREATE DATABASE ${qIdent(database, engine)};`;
  return regexEscape(queryStr);
};

export const renameDatabaseQuery = (
  database: string,
  newDatabase: string,
  engine?: DatabaseEngine
) => {
  if (engine === "sqlserver") {
    return regexEscape(
      `ALTER DATABASE ${qIdent(database, engine)} MODIFY NAME = ${qIdent(newDatabase, engine)};`
    );
  }
  if (engine === "clickhouse") {
    return regexEscape(
      `RENAME DATABASE ${qIdent(database, engine)} TO ${qIdent(newDatabase, engine)}`
    );
  }
  const queryStr = `ALTER DATABASE ${qIdent(database, engine)} RENAME TO ${qIdent(newDatabase, engine)};`;
  return regexEscape(queryStr);
};

export const dropDatabaseQuery = (
  database: string,
  engine?: DatabaseEngine
) => {
  const queryStr = `DROP DATABASE ${qIdent(database, engine)};`;
  return regexEscape(queryStr);
};
