import type { DatabaseEngine } from "src/types";
import { isSqlitePragmaEngine, qLiteral, regexEscape } from "./shared";

export const tableStructuresQuery = (
  schema: string,
  tableName: string,
  oid: number,
  engine?: DatabaseEngine
) => {
  if (isSqlitePragmaEngine(engine)) {
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

  if (engine === "duckdb") {
    const queryStr = `
      SELECT
        c.ordinal_position,
        c.column_name,
        c.data_type,
        c.data_type AS format_type,
        c.numeric_precision,
        c.datetime_precision,
        c.numeric_scale,
        c.character_maximum_length AS data_length,
        c.is_nullable,
        '' AS "check",
        '' AS check_constraint,
        c.column_default,
        '' AS comment
      FROM information_schema.columns c
      WHERE c.table_schema = ${qLiteral(schema)}
        AND c.table_name = ${qLiteral(tableName)}
      ORDER BY c.ordinal_position;
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

  if (engine === "clickhouse") {
    const queryStr = `
      SELECT
        ordinal_position,
        column_name,
        data_type,
        data_type AS format_type,
        numeric_precision,
        datetime_precision,
        numeric_scale,
        character_maximum_length AS data_length,
        if(is_nullable IN (1), 'YES', 'NO') AS is_nullable,
        '' AS check_expr_txt,
        '' AS check_constraint_txt,
        column_default AS column_default_txt,
        column_comment AS comment_txt
      FROM information_schema.columns
      WHERE table_catalog = currentDatabase()
        AND table_schema = ${qLiteral(schema)}
        AND table_name = ${qLiteral(tableName)}
      ORDER BY ordinal_position;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "sqlserver" || engine === "snowflake") {
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
  if (isSqlitePragmaEngine(engine)) {
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

  if (engine === "duckdb") {
    const queryStr = `
      WITH constraint_indexes AS (
        SELECT
          CASE
            WHEN constraint_type = 'PRIMARY KEY' THEN 'PRIMARY'
            ELSE COALESCE(constraint_text, constraint_type)
          END AS index_name,
          'BTREE' AS index_algorithm,
          CASE
            WHEN constraint_type IN ('PRIMARY KEY', 'UNIQUE') THEN 'true'
            ELSE 'false'
          END AS is_unique,
          CASE WHEN constraint_type = 'PRIMARY KEY' THEN 'true' ELSE 'false' END AS is_primary,
          COALESCE(constraint_text, '') AS index_definition,
          array_to_string(constraint_column_names, ',') AS column_name,
          '' AS condition,
          '' AS include,
          '' AS comment
        FROM duckdb_constraints()
        WHERE schema_name = ${qLiteral(schema)}
          AND table_name = ${qLiteral(tableName)}
          AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      ),
      secondary_indexes AS (
        SELECT
          index_name,
          'BTREE' AS index_algorithm,
          CASE WHEN is_unique THEN 'true' ELSE 'false' END AS is_unique,
          'false' AS is_primary,
          COALESCE(sql, '') AS index_definition,
          COALESCE(NULLIF(expressions, ''), index_name) AS column_name,
          '' AS condition,
          '' AS include,
          '' AS comment
        FROM duckdb_indexes()
        WHERE schema_name = ${qLiteral(schema)}
          AND table_name = ${qLiteral(tableName)}
      )
      SELECT *
      FROM (
        SELECT *
        FROM constraint_indexes
        WHERE column_name IS NOT NULL AND trim(column_name) <> ''
        UNION ALL
        SELECT *
        FROM secondary_indexes
      )
      ORDER BY CASE WHEN index_name = 'PRIMARY' THEN 0 ELSE 1 END, index_name;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "snowflake") {
    return regexEscape(`SELECT '' WHERE 1=0`);
  }

  if (engine === "clickhouse") {
    const queryStr = `
      SELECT
        'PRIMARY' AS index_name,
        'PRIMARY' AS index_algorithm,
        'true' AS is_unique,
        'true' AS is_primary,
        sorting_key AS index_definition,
        if(primary_key != '', primary_key, sorting_key) AS column_name,
        '' AS condition_txt,
        '' AS include_txt,
        '' AS comment_txt
      FROM system.tables
      WHERE database = currentDatabase()
        AND name = ${qLiteral(tableName)}
        AND (primary_key != '' OR sorting_key != '')
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

  // Snowflake read-only roles often cannot access KEY_COLUMN_USAGE / referential_constraints.
  if (engine === "snowflake" || engine === "clickhouse") {
    return regexEscape(`SELECT '' WHERE 1=0`);
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
