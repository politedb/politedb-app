import type { DatabaseEngine, TableColumn } from "src/types";

export function isMySqlLike(engine?: DatabaseEngine) {
  return engine === "mysql" || engine === "mariadb";
}

export function qIdent(ident: string, engine?: DatabaseEngine) {
  const raw = String(ident);
  if (isMySqlLike(engine)) {
    return `\`${raw.replace(/`/g, "``")}\``;
  }
  return `"${raw.replace(/"/g, `""`)}"`;
}

export function qLiteral(v: string) {
  return `'${String(v).replace(/'/g, `''`)}'`;
}

export function regexEscape(s: string) {
  return s.replace(/\s*=\s*/g, "=").replace(/\s+/g, " ");
}

export const listTablesQuery = (schema: string) => {
  const queryStr = `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema = ${qLiteral(schema)}
      AND table_schema NOT LIKE 'pg_%'
      AND table_schema <> 'information_schema'
    ORDER BY table_schema, table_name;
  `;
  return regexEscape(queryStr);
};

export const dbSchemasQuery = () => {
  const queryStr = `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE
      schema_name NOT LIKE 'pg_%'
      AND schema_name <> 'information_schema'
  `;
  return regexEscape(queryStr);
};

export const tableSizeInfoQuery = (schema: string, tableName: string) => {
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

export const tableColumnsQuery = (schema: string, tableName: string) => {
  const queryStr = `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = ${qLiteral(schema)}
      AND table_name = ${qLiteral(tableName)}
    ORDER BY ordinal_position;
  `;
  return regexEscape(queryStr);
};

// Filter condition for table data (WHERE clause)
export type TableFilterCondition = {
  column: string;
  operator: string;
  value: string;
  enabled: boolean;
};

const VALUE_OPS = ["=", "!=", "<>", "<", ">", "<=", ">=", "LIKE", "ILIKE"];
const IN_OPS = ["IN", "NOT IN"];
const NULL_OPS = ["IS NULL", "IS NOT NULL"];

function buildWhereClause(
  filters: TableFilterCondition[],
  combineWith: "AND" | "OR",
  engine?: DatabaseEngine
): string {
  const parts = filters
    .filter((f) => f.enabled && (f.column ?? "").trim())
    .map((f) => {
      const col = qIdent(String(f.column).trim(), engine);
      const op = String(f.operator).toUpperCase();
      if (NULL_OPS.includes(op)) {
        return `${col} ${op}`;
      }
      if (IN_OPS.includes(op)) {
        const raw = (f.value ?? "").trim();
        const values = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => qLiteral(s));
        if (values.length === 0) return "";
        return `${col} ${op} (${values.join(", ")})`;
      }
      if (VALUE_OPS.includes(op)) {
        const val = (f.value ?? "").trim();
        if (op === "LIKE" || op === "ILIKE") {
          const literal = qLiteral(`%${val}%`);
          return `${col} ${op} ${literal}`;
        }
        return `${col} ${op} ${qLiteral(val)}`;
      }
      return `${col} = ${qLiteral(String(f.value ?? "").trim())}`;
    })
    .filter(Boolean);
  if (parts.length === 0) return "";
  return " WHERE " + parts.join(` ${combineWith} `);
}

export const tableDataQuery = (
  schema: string,
  tableName: string,
  pagination?: { limit: number; offset: number },
  filters?: TableFilterCondition[],
  combineWith: "AND" | "OR" = "AND",
  engine?: DatabaseEngine
) => {
  const limit = pagination?.limit ?? 300;
  const offset = pagination?.offset ?? 0;
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;
  const where = filters?.length
    ? buildWhereClause(filters, combineWith, engine)
    : "";
  const queryStr = `SELECT * FROM ${tableIdent}${where} LIMIT ${limit} OFFSET ${offset};`;
  return regexEscape(queryStr);
};

/** Full table query for export (no LIMIT; backend streams with batch_size/max_rows). */
export const tableExportQuery = (
  schema: string,
  tableName: string,
  columns?: string[],
  filters?: TableFilterCondition[],
  combineWith: "AND" | "OR" = "AND",
  engine?: DatabaseEngine
) => {
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;
  const colList =
    columns && columns.length > 0
      ? columns.map((c) => qIdent(c, engine)).join(", ")
      : "*";
  const where = filters?.length
    ? buildWhereClause(filters, combineWith, engine)
    : "";
  const queryStr = `SELECT ${colList} FROM ${tableIdent}${where};`;
  return regexEscape(queryStr);
};

export const tableRowCountQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;
  const queryStr = `SELECT COUNT(*) FROM ${tableIdent};`;
  return regexEscape(queryStr);
};

export const tableOidQuery = (schema: string, tableName: string) => {
  const queryStr = `SELECT '${qIdent(schema)}.${qIdent(tableName)}'::regclass::oid;`;
  return regexEscape(queryStr);
};

export const tableStructuresQuery = (
  schema: string,
  tableName: string,
  oid: number
) => {
  const queryStr = `
    SELECT
      ordinal_position,
      column_name,
      udt_name AS data_type,
      format_type(atttypid, atttypmod) AS FORMAT_TYPE,
      numeric_precision,
      datetime_precision,
      numeric_scale,
      character_maximum_length AS data_length,
      is_nullable,
      column_name AS CHECK,
      column_name AS check_constraint,
      column_default,
      pg_catalog.col_description (${oid}, ordinal_position) AS comment
    FROM
      information_schema.columns
      JOIN pg_attribute pa ON attrelid = ${oid}
      AND attname = column_name
    WHERE
      table_name = ${qLiteral(tableName)}
      AND table_schema = ${qLiteral(schema)}
  `;
  return regexEscape(queryStr);
};

export const tableConstraintsQuery = (schema: string, tableName: string) => {
  const queryStr = `
    SELECT
      ix.relname AS index_name,
      upper(am.amname) AS index_algorithm,
      indisunique AS is_unique,
      pg_get_indexdef(indexrelid) AS index_definition,
      replace(regexp_replace(regexp_replace(regexp_replace(pg_get_indexdef(indexrelid), ' WHERE .+|INCLUDE .+', ''), ' WITH .+', ''), '.*\\((.*)\\)', '\\1'), ' ', '') AS column_name,
      CASE
        WHEN position(' WHERE ' IN pg_get_indexdef(indexrelid)) > 0 THEN regexp_replace(pg_get_indexdef(indexrelid), '.+WHERE ', '')
        WHEN position(' WITH ' IN pg_get_indexdef(indexrelid)) > 0 THEN regexp_replace(pg_get_indexdef(indexrelid), '.+WITH ', '')
        ELSE ''
      END AS condition,
      CASE
        WHEN position(' INCLUDE ' IN pg_get_indexdef(indexrelid)) > 0 THEN regexp_replace(pg_get_indexdef(indexrelid), '.+INCLUDE ', '')
        WHEN position(' WITH ' IN pg_get_indexdef(indexrelid)) > 0 THEN regexp_replace(pg_get_indexdef(indexrelid), '.+WITH ', '')
        ELSE ''
      END AS include,
      pg_catalog.obj_description (i.indexrelid, 'pg_class') AS comment
    FROM
      pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_class ix ON ix.oid = i.indexrelid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN pg_am AS am ON ix.relam = am.oid
    WHERE
      t.relname = ${qLiteral(tableName)}
      AND n.nspname = ${qLiteral(schema)}
  `;
  return regexEscape(queryStr);
};

/** Foreign keys for a table (Postgres). Returns one row per FK with aggregated columns. */
export const tableForeignKeysQuery = (schema: string, tableName: string) => {
  const queryStr = `
    WITH fk AS (
      SELECT
        kcu.constraint_name,
        kcu.table_schema,
        kcu.table_name,
        kcu.column_name,
        kcu.ordinal_position,
        ref_kcu.table_schema AS ref_table_schema,
        ref_kcu.table_name AS ref_table_name,
        ref_kcu.column_name AS ref_column_name,
        rc.update_rule AS on_update,
        rc.delete_rule AS on_delete
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = rc.constraint_name
        AND kcu.constraint_schema = rc.constraint_schema
      JOIN information_schema.key_column_usage ref_kcu
        ON ref_kcu.constraint_name = rc.unique_constraint_name
        AND ref_kcu.constraint_schema = rc.unique_constraint_schema
        AND ref_kcu.ordinal_position = kcu.position_in_unique_constraint
      WHERE kcu.table_schema = ${qLiteral(schema)}
        AND kcu.table_name = ${qLiteral(tableName)}
    )
    SELECT
      constraint_name,
      table_schema,
      table_name,
      string_agg(column_name, ',' ORDER BY ordinal_position) AS column_names,
      max(ref_table_schema) AS ref_table_schema,
      max(ref_table_name) AS ref_table_name,
      string_agg(ref_column_name, ',' ORDER BY ordinal_position) AS ref_column_names,
      max(on_update) AS on_update,
      max(on_delete) AS on_delete
    FROM fk
    GROUP BY constraint_name, table_schema, table_name
    ORDER BY constraint_name;
  `;
  return regexEscape(queryStr);
};

export const tableStructuresMySqlQuery = (
  schema: string,
  tableName: string
) => {
  const queryStr = `
    SELECT
      ordinal_position,
      column_name,
      column_type AS data_type,
      is_nullable,
      column_default,
      column_comment,
      character_set_name AS character_set,
      collation_name AS collation,
      extra,
      column_name AS foreign_key
    FROM information_schema.columns
    WHERE table_schema = ${qLiteral(schema)}
      AND table_name = ${qLiteral(tableName)}
    ORDER BY ordinal_position;
  `;
  return regexEscape(queryStr);
};

export const tableConstraintsMySqlQuery = (
  schema: string,
  tableName: string
) => {
  const queryStr = `
    SELECT
      index_name,
      index_type,
      non_unique,
      GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS column_name
    FROM information_schema.statistics
    WHERE table_schema = ${qLiteral(schema)}
      AND table_name = ${qLiteral(tableName)}
    GROUP BY index_name, index_type, non_unique
    ORDER BY index_name;
  `;
  return regexEscape(queryStr);
};

export const createTableQuery = (
  schema: string,
  tableName: string,
  columns: TableColumn[],
  primaryKey: string | string[]
) => {
  const columnDefinitions = columns
    .map((col) => {
      let def = `${qIdent(col.column_name)} ${col.data_type}`;

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
          def += ` DEFAULT ${qLiteral(defaultVal)}`;
        }
      }

      return def;
    })
    .join(",\n      ");

  // Add PRIMARY KEY constraint (support single or multiple columns)
  const primaryKeyColumns = Array.isArray(primaryKey)
    ? primaryKey.filter(Boolean)
    : primaryKey
      ? [primaryKey]
      : [];
  const primaryKeyConstraint =
    primaryKeyColumns.length > 0
      ? `,\n      PRIMARY KEY (${primaryKeyColumns.map((key) => qIdent(key)).join(", ")})`
      : "";

  const queryStr = `
    CREATE TABLE ${qIdent(schema)}.${qIdent(tableName)} (
      ${columnDefinitions}${primaryKeyConstraint}
    );
  `;
  return regexEscape(queryStr);
};

export const createSchemaQuery = (schema: string) => {
  const queryStr = `CREATE SCHEMA ${qIdent(schema)};`;
  return regexEscape(queryStr);
};

export const copyTableDataQuery = (
  schema: string,
  tableName: string,
  newTableName: string
) => {
  const queryStr = `INSERT INTO ${qIdent(schema)}.${qIdent(newTableName)} SELECT * FROM ${qIdent(schema)}.${qIdent(tableName)};`;
  return regexEscape(queryStr);
};

export const cloneTableQuery = (
  schema: string,
  tableName: string,
  newTableName: string
) => {
  const queryStr = `CREATE TABLE ${qIdent(schema)}.${qIdent(newTableName)} (LIKE ${qIdent(schema)}.${qIdent(tableName)} INCLUDING ALL);`;
  return regexEscape(queryStr);
};

export const dropTableQuery = (schema: string, tableName: string) => {
  const queryStr = `DROP TABLE ${qIdent(schema)}.${qIdent(tableName)};`;
  return regexEscape(queryStr);
};

export const truncateTableQuery = (
  schema: string,
  tableName: string,
  opts?: { restartIdentity?: boolean; cascade?: boolean }
) => {
  const parts = ["TRUNCATE TABLE", `${qIdent(schema)}.${qIdent(tableName)}`];
  if (opts?.restartIdentity) {
    parts.push("RESTART IDENTITY");
  }
  parts.push(opts?.cascade !== false ? "CASCADE" : "RESTRICT");
  const queryStr = `${parts.join(" ")};`;
  return regexEscape(queryStr);
};

export const dbListQuery = (engine?: DatabaseEngine) => {
  if (isMySqlLike(engine)) {
    return "SELECT schema_name FROM information_schema.schemata WHERE schema_name = DATABASE() ORDER BY schema_name;";
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
