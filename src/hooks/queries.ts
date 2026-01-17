function qIdent(ident: string) {
  return `"${String(ident).replace(/"/g, `""`)}"`;
}

function qLiteral(v: string) {
  return `'${String(v).replace(/"/g, `""`)}'`;
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

export const tableDataQuery = (
  schema: string,
  tableName: string,
  limit: number = 300,
  offset: number = 0
) => {
  const tableIdent = `${qIdent(schema)}.${qIdent(tableName)}`;
  const queryStr = `SELECT * FROM ${tableIdent} LIMIT ${limit} OFFSET ${offset};`;
  return regexEscape(queryStr);
};

export const tableRowCountQuery = (schema: string, tableName: string) => {
  const tableIdent = `${qIdent(schema)}.${qIdent(tableName)}`;
  const queryStr = `SELECT COUNT(*) FROM ${tableIdent};`;
  return regexEscape(queryStr);
};

export const tableStructuresQuery = (schema: string, tableName: string) => {
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
      column_name AS foreign_key,
      pg_catalog.col_description (16464, ordinal_position) AS comment
    FROM
      information_schema.columns
      JOIN pg_attribute pa ON attrelid = 16464
      AND attname = column_name
    WHERE
      table_name = ${qLiteral(tableName)}
      AND table_schema = ${qLiteral(schema)}
  `;
  return regexEscape(queryStr);
};

export const tableRelationshipsQuery = (schema: string, tableName: string) => {
  const queryStr = `
    SELECT
      ix.relname AS index_name,
      upper(am.amname) AS index_algorithm,
      indisunique AS is_unique,
      pg_get_indexdef(indexrelid) AS index_definition,
      replace(regexp_replace(regexp_replace(regexp_replace(pg_get_indexdef(indexrelid), ' WHERE .+|INCLUDE .+', ''), ' WITH .+', ''), '.*\((.*)\)', '\\1'), ' ', '') AS column_name,
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
