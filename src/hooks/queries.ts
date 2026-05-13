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

export const tableSizeInfoQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
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

export const tableColumnsQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  if (engine === "sqlite") {
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
  if (engine === "sqlite") {
    const queryStr = `
      SELECT name AS column_name, type AS data_type,
        CASE WHEN IFNULL(pk, 0) != 0 THEN 1 ELSE 0 END AS is_primary
      FROM pragma_table_info(${qLiteral(tableName)})
      ORDER BY cid;
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

// Filter condition for table data (WHERE clause)
export type TableFilterCondition = {
  id: number;
  column: string;
  operator: string;
  value: string;
  enabled: boolean;
};

export type TableSort = {
  colName: string;
  direction: "asc" | "desc";
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
          if (engine === "oracle" && op === "ILIKE") {
            return `LOWER(${col}) LIKE LOWER(${literal})`;
          }
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
  sortBy?: TableSort | null,
  engine?: DatabaseEngine
) => {
  const limit = pagination?.limit ?? 300;
  const offset = pagination?.offset ?? 0;
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;
  const where = filters?.length
    ? buildWhereClause(filters, combineWith, engine)
    : "";
  const orderBy = sortBy
    ? ` ORDER BY ${qIdent(sortBy.colName, engine)} ${sortBy.direction.toUpperCase()}`
    : "";
  const queryStr =
    engine === "oracle"
      ? `SELECT * FROM ${tableIdent}${where}${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY;`
      : engine === "sqlserver"
        ? `SELECT * FROM ${tableIdent}${where}${orderBy || " ORDER BY (SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY;`
      : `SELECT * FROM ${tableIdent}${where}${orderBy} LIMIT ${limit} OFFSET ${offset};`;
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
  filters?: TableFilterCondition[],
  combineWith: "AND" | "OR" = "AND",
  engine?: DatabaseEngine
) => {
  const tableIdent = `${qIdent(schema, engine)}.${qIdent(tableName, engine)}`;
  const where = filters?.length
    ? buildWhereClause(filters, combineWith, engine)
    : "";
  const queryStr = `SELECT COUNT(*) FROM ${tableIdent}${where};`;
  return regexEscape(queryStr);
};

export const tableEstimatedRowCountQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  if (engine === "postgres") {
    const queryStr = `
      SELECT GREATEST(pc.reltuples::bigint, 0)::bigint
      FROM pg_class pc
      JOIN pg_namespace pn ON pn.oid = pc.relnamespace
      WHERE pn.nspname = ${qLiteral(schema)}
        AND pc.relname = ${qLiteral(tableName)}
        AND pc.relkind IN ('r', 'p', 'm');
    `;
    return regexEscape(queryStr);
  }

  if (isMySqlLike(engine)) {
    const queryStr = `
      SELECT COALESCE(table_rows, 0)
      FROM information_schema.tables
      WHERE table_schema = ${qLiteral(schema)}
        AND table_name = ${qLiteral(tableName)}
      LIMIT 1;
    `;
    return regexEscape(queryStr);
  }

  return null;
};

/** If estimated row count is below this, we use SELECT COUNT(*) to show the real count. */
export const ESTIMATE_USE_EXACT_BELOW = 100_000;

export const tableOidQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  if (engine === "sqlite" || engine === "oracle" || engine === "sqlserver") {
    return "SELECT 0;";
  }

  const queryStr = `SELECT '${qIdent(schema)}.${qIdent(tableName)}'::regclass::oid;`;
  return regexEscape(queryStr);
};

export const tableStructuresQuery = (
  schema: string,
  tableName: string,
  oid: number,
  engine?: DatabaseEngine
) => {
  if (engine === "sqlite") {
    const queryStr = `
      SELECT
        cid + 1 AS ordinal_position,
        name AS column_name,
        type AS data_type,
        type AS format_type,
        NULL AS numeric_precision,
        NULL AS datetime_precision,
        NULL AS numeric_scale,
        NULL AS data_length,
        CASE WHEN "notnull" = 1 THEN 'NO' ELSE 'YES' END AS is_nullable,
        '' AS "check",
        '' AS check_constraint,
        dflt_value AS column_default,
        '' AS comment
      FROM pragma_table_info(${qLiteral(tableName)})
      ORDER BY cid;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "oracle") {
    const queryStr = `
      SELECT
        column_id AS ordinal_position,
        column_name,
        data_type,
        data_type AS format_type,
        data_precision AS numeric_precision,
        NULL AS datetime_precision,
        data_scale AS numeric_scale,
        data_length,
        CASE WHEN nullable = 'Y' THEN 'YES' ELSE 'NO' END AS is_nullable,
        '' AS check_expr_txt,
        '' AS check_constraint_txt,
        data_default AS column_default_txt,
        '' AS comment_txt
      FROM all_tab_columns
      WHERE owner = ${qLiteral(schema.toUpperCase())}
        AND table_name = ${qLiteral(tableName.toUpperCase())}
      ORDER BY column_id;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "sqlserver") {
    const queryStr = `
      SELECT
        c.ORDINAL_POSITION AS ordinal_position,
        c.COLUMN_NAME AS column_name,
        c.DATA_TYPE AS data_type,
        c.DATA_TYPE AS format_type,
        c.NUMERIC_PRECISION AS numeric_precision,
        c.DATETIME_PRECISION AS datetime_precision,
        c.NUMERIC_SCALE AS numeric_scale,
        c.CHARACTER_MAXIMUM_LENGTH AS data_length,
        CASE WHEN c.IS_NULLABLE = 'YES' THEN 'YES' ELSE 'NO' END AS is_nullable,
        '' AS check_expr_txt,
        '' AS check_constraint_txt,
        c.COLUMN_DEFAULT AS column_default_txt,
        '' AS comment_txt
      FROM INFORMATION_SCHEMA.COLUMNS c
      WHERE c.TABLE_SCHEMA = ${qLiteral(schema)}
        AND c.TABLE_NAME = ${qLiteral(tableName)}
      ORDER BY c.ORDINAL_POSITION;
    `;
    return regexEscape(queryStr);
  }

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

export const tableConstraintsQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  if (engine === "sqlite") {
    const queryStr = `
      WITH pk AS (
        SELECT
          'PRIMARY' AS index_name,
          'BTREE' AS index_algorithm,
          'true' AS is_unique,
          'true' AS is_primary,
          '' AS index_definition,
          group_concat(name, ',') AS column_name,
          '' AS condition,
          '' AS include,
          '' AS comment
        FROM (
          SELECT name
          FROM pragma_table_info(${qLiteral(tableName)})
          WHERE pk > 0
          ORDER BY pk
        )
      ),
      idx AS (
        SELECT
          il.name AS index_name,
          'BTREE' AS index_algorithm,
          CASE WHEN il."unique" = 1 THEN 'true' ELSE 'false' END AS is_unique,
          CASE WHEN il.origin = 'pk' THEN 'true' ELSE 'false' END AS is_primary,
          '' AS index_definition,
          (
            SELECT group_concat(ii.name, ',')
            FROM pragma_index_info(il.name) ii
          ) AS column_name,
          '' AS condition,
          '' AS include,
          '' AS comment
        FROM pragma_index_list(${qLiteral(tableName)}) il
      )
      SELECT *
      FROM (
        SELECT *
        FROM pk
        WHERE column_name IS NOT NULL AND trim(column_name) <> ''
        UNION ALL
        SELECT *
        FROM idx
      )
      ORDER BY CASE WHEN index_name = 'PRIMARY' THEN 0 ELSE 1 END, index_name;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "oracle") {
    const queryStr = `
      SELECT
        ai.index_name AS index_name,
        ai.index_type AS index_algorithm,
        CASE WHEN ai.uniqueness = 'UNIQUE' THEN 'true' ELSE 'false' END AS is_unique,
        CASE WHEN ac.constraint_type = 'P' THEN 'true' ELSE 'false' END AS is_primary,
        '' AS index_definition_txt,
        LISTAGG(aic.column_name, ',') WITHIN GROUP (ORDER BY aic.column_position) AS column_name,
        '' AS condition_txt,
        '' AS include_txt,
        '' AS comment_txt
      FROM all_indexes ai
      JOIN all_ind_columns aic
        ON aic.index_owner = ai.owner
       AND aic.index_name = ai.index_name
      LEFT JOIN all_constraints ac
        ON ac.owner = ai.table_owner
       AND ac.table_name = ai.table_name
       AND ac.index_name = ai.index_name
       AND ac.constraint_type = 'P'
      WHERE ai.table_owner = ${qLiteral(schema.toUpperCase())}
        AND ai.table_name = ${qLiteral(tableName.toUpperCase())}
      GROUP BY
        ai.index_name,
        ai.index_type,
        ai.uniqueness,
        ac.constraint_type
      ORDER BY ai.index_name;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "sqlserver") {
    const queryStr = `
      SELECT
        i.name AS index_name,
        i.type_desc AS index_algorithm,
        CASE WHEN i.is_unique = 1 THEN 'true' ELSE 'false' END AS is_unique,
        CASE WHEN i.is_primary_key = 1 THEN 'true' ELSE 'false' END AS is_primary,
        '' AS index_definition_txt,
        STRING_AGG(col.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS column_name,
        '' AS condition_txt,
        '' AS include_txt,
        '' AS comment_txt
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.indexes i ON i.object_id = t.object_id
      JOIN sys.index_columns ic
        ON ic.object_id = i.object_id
       AND ic.index_id = i.index_id
       AND ic.is_included_column = 0
      JOIN sys.columns col
        ON col.object_id = ic.object_id
       AND col.column_id = ic.column_id
      WHERE s.name = ${qLiteral(schema)}
        AND t.name = ${qLiteral(tableName)}
        AND i.index_id > 0
        AND i.name IS NOT NULL
      GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
      ORDER BY i.name;
    `;
    return regexEscape(queryStr);
  }

  const queryStr = `
    SELECT
      ix.relname AS index_name,
      upper(am.amname) AS index_algorithm,
      indisunique AS is_unique,
      indisprimary AS is_primary,
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
export const tableForeignKeysQuery = (
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) => {
  if (schema === "main") {
    return `
      SELECT '' WHERE 1=0;
    `;
  }

  if (engine === "oracle") {
    const queryStr = `
      WITH fk_cols AS (
        SELECT
          c.owner AS table_schema,
          c.table_name,
          c.constraint_name,
          c.r_owner,
          c.r_constraint_name,
          cc.column_name,
          cc.position
        FROM all_constraints c
        JOIN all_cons_columns cc
          ON cc.owner = c.owner
         AND cc.constraint_name = c.constraint_name
        WHERE c.constraint_type = 'R'
          AND c.owner = ${qLiteral(schema.toUpperCase())}
          AND c.table_name = ${qLiteral(tableName.toUpperCase())}
      ),
      pk_cols AS (
        SELECT
          c.owner AS ref_table_schema,
          c.table_name AS ref_table_name,
          c.constraint_name,
          cc.column_name,
          cc.position
        FROM all_constraints c
        JOIN all_cons_columns cc
          ON cc.owner = c.owner
         AND cc.constraint_name = c.constraint_name
        WHERE c.constraint_type IN ('P', 'U')
      )
      SELECT
        fk.constraint_name,
        fk.table_schema,
        fk.table_name,
        LISTAGG(fk.column_name, ',') WITHIN GROUP (ORDER BY fk.position) AS column_names,
        MAX(pk.ref_table_schema) AS ref_table_schema,
        MAX(pk.ref_table_name) AS ref_table_name,
        LISTAGG(pk.column_name, ',') WITHIN GROUP (ORDER BY fk.position) AS ref_column_names,
        'NO ACTION' AS on_update,
        (
          SELECT
            CASE c.delete_rule
              WHEN 'CASCADE' THEN 'CASCADE'
              WHEN 'SET NULL' THEN 'SET NULL'
              ELSE 'NO ACTION'
            END
          FROM all_constraints c
          WHERE c.owner = fk.table_schema
            AND c.constraint_name = fk.constraint_name
        ) AS on_delete
      FROM fk_cols fk
      JOIN pk_cols pk
        ON pk.ref_table_schema = fk.r_owner
       AND pk.constraint_name = fk.r_constraint_name
       AND pk.position = fk.position
      GROUP BY fk.constraint_name, fk.table_schema, fk.table_name
      ORDER BY fk.constraint_name;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "sqlserver") {
    const queryStr = `
      WITH fk AS (
        SELECT
          fk.name AS constraint_name,
          s.name AS table_schema,
          t.name AS table_name,
          c.name AS column_name,
          rs.name AS ref_table_schema,
          rt.name AS ref_table_name,
          rc.name AS ref_column_name,
          fkc.constraint_column_id AS ordinal_position,
          fk.update_referential_action_desc AS on_update,
          fk.delete_referential_action_desc AS on_delete
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc
          ON fkc.constraint_object_id = fk.object_id
        JOIN sys.tables t
          ON t.object_id = fk.parent_object_id
        JOIN sys.schemas s
          ON s.schema_id = t.schema_id
        JOIN sys.columns c
          ON c.object_id = t.object_id
         AND c.column_id = fkc.parent_column_id
        JOIN sys.tables rt
          ON rt.object_id = fk.referenced_object_id
        JOIN sys.schemas rs
          ON rs.schema_id = rt.schema_id
        JOIN sys.columns rc
          ON rc.object_id = rt.object_id
         AND rc.column_id = fkc.referenced_column_id
        WHERE s.name = ${qLiteral(schema)}
          AND t.name = ${qLiteral(tableName)}
      )
      SELECT
        constraint_name,
        table_schema,
        table_name,
        STRING_AGG(column_name, ',') WITHIN GROUP (ORDER BY ordinal_position) AS column_names,
        MAX(ref_table_schema) AS ref_table_schema,
        MAX(ref_table_name) AS ref_table_name,
        STRING_AGG(ref_column_name, ',') WITHIN GROUP (ORDER BY ordinal_position) AS ref_column_names,
        MAX(on_update) AS on_update,
        MAX(on_delete) AS on_delete
      FROM fk
      GROUP BY constraint_name, table_schema, table_name
      ORDER BY constraint_name;
    `;
    return regexEscape(queryStr);
  }

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
      CASE WHEN UPPER(index_name) = 'PRIMARY' THEN TRUE ELSE FALSE END AS is_primary,
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
  primaryKey: string | string[],
  engine?: DatabaseEngine
) => {
  const columnDefinitions = columns
    .map((col) => {
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
      ? `,\n      PRIMARY KEY (${primaryKeyColumns.map((key) => qIdent(key, engine)).join(", ")})`
      : "";

  const queryStr = `
    CREATE TABLE ${qIdent(schema, engine)}.${qIdent(tableName, engine)} (
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
  if (engine === "sqlserver") {
    return "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name;";
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
