function qIdent(ident: string) {
  return `"${String(ident).replace(/"/g, `""`)}"`;
}

function qLiteral(v: string) {
  return `'${String(v).replace(/"/g, `""`)}'`;
}

export const listTablesQuery = (schema: string) =>
  `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema = ${qLiteral(schema)}
      AND table_schema NOT LIKE 'pg_%'
      AND table_schema <> 'information_schema'
    ORDER BY table_schema, table_name;
  `.trim();

export const dbSchemasQuery = () =>
  `
    SELECT schema_name
    FROM information_schema.schemata
    WHERE
      schema_name NOT LIKE 'pg_%'
      AND schema_name <> 'information_schema'
  `.trim();

export const tableSizeInfoQuery = (schema: string, tableName: string) =>
  `
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
  `.trim();

export const tableColumnsQuery = (schema: string, tableName: string) =>
  `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = ${qLiteral(schema)}
      AND table_name   = ${qLiteral(tableName)}
    ORDER BY ordinal_position;
  `.trim();

export const tableDataQuery = (
  schema: string,
  tableName: string,
  limit: number = 300,
  offset: number = 0
) => {
  const tableIdent = `${qIdent(schema)}.${qIdent(tableName)}`;
  return `SELECT * FROM ${tableIdent} LIMIT ${limit} OFFSET ${offset};`.trim();
};

export const tableRowCountQuery = (schema: string, tableName: string) => {
  const tableIdent = `${qIdent(schema)}.${qIdent(tableName)}`;
  return `SELECT COUNT(*) FROM ${tableIdent};`.trim();
};
