import type { DatabaseEngine } from "src/types";
import { isMySqlLike, qLiteral, regexEscape } from "./shared";

export type DiagramSchemaMetadataQueries = {
  foreignKeys: string;
  uniqueConstraints: string;
};

/** Schema-wide diagram metadata for remote SQL engines. Two round trips replace per-table queries. */
export function diagramSchemaMetadataQueries(
  schema: string,
  engine?: DatabaseEngine
): DiagramSchemaMetadataQueries | null {
  if (isMySqlLike(engine)) {
    return {
      foreignKeys: regexEscape(`
        SELECT
          kcu.constraint_name,
          kcu.table_schema,
          kcu.table_name,
          GROUP_CONCAT(kcu.column_name ORDER BY kcu.ordinal_position SEPARATOR ',') AS column_names,
          MAX(kcu.referenced_table_schema) AS ref_table_schema,
          MAX(kcu.referenced_table_name) AS ref_table_name,
          GROUP_CONCAT(kcu.referenced_column_name ORDER BY kcu.ordinal_position SEPARATOR ',') AS ref_column_names,
          MAX(rc.update_rule) AS on_update,
          MAX(rc.delete_rule) AS on_delete
        FROM information_schema.key_column_usage kcu
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_schema = kcu.constraint_schema
         AND rc.constraint_name = kcu.constraint_name
         AND rc.table_name = kcu.table_name
        WHERE kcu.table_schema = ${qLiteral(schema)}
          AND kcu.referenced_table_name IS NOT NULL
        GROUP BY kcu.constraint_name, kcu.table_schema, kcu.table_name
        ORDER BY kcu.table_name, kcu.constraint_name;
      `),
      uniqueConstraints: regexEscape(`
        SELECT
          table_name,
          CASE WHEN UPPER(index_name) = 'PRIMARY' THEN TRUE ELSE FALSE END AS is_primary,
          GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS column_names
        FROM information_schema.statistics
        WHERE table_schema = ${qLiteral(schema)}
          AND non_unique = 0
        GROUP BY table_name, index_name
        ORDER BY table_name, index_name;
      `),
    };
  }

  if (engine !== "postgres") return null;

  return {
    foreignKeys: regexEscape(`
      SELECT
        con.conname AS constraint_name,
        child_ns.nspname AS table_schema,
        child.relname AS table_name,
        string_agg(child_att.attname, ',' ORDER BY child_key.ordinality) AS column_names,
        parent_ns.nspname AS ref_table_schema,
        parent.relname AS ref_table_name,
        string_agg(parent_att.attname, ',' ORDER BY child_key.ordinality) AS ref_column_names,
        CASE con.confupdtype
          WHEN 'c' THEN 'CASCADE'
          WHEN 'n' THEN 'SET NULL'
          WHEN 'd' THEN 'SET DEFAULT'
          WHEN 'r' THEN 'RESTRICT'
          ELSE 'NO ACTION'
        END AS on_update,
        CASE con.confdeltype
          WHEN 'c' THEN 'CASCADE'
          WHEN 'n' THEN 'SET NULL'
          WHEN 'd' THEN 'SET DEFAULT'
          WHEN 'r' THEN 'RESTRICT'
          ELSE 'NO ACTION'
        END AS on_delete
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class child
        ON child.oid = con.conrelid
      JOIN pg_catalog.pg_namespace child_ns
        ON child_ns.oid = child.relnamespace
      JOIN pg_catalog.pg_class parent
        ON parent.oid = con.confrelid
      JOIN pg_catalog.pg_namespace parent_ns
        ON parent_ns.oid = parent.relnamespace
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS child_key(attnum, ordinality)
        ON TRUE
      JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS parent_key(attnum, ordinality)
        ON parent_key.ordinality = child_key.ordinality
      JOIN pg_catalog.pg_attribute child_att
        ON child_att.attrelid = child.oid
       AND child_att.attnum = child_key.attnum
      JOIN pg_catalog.pg_attribute parent_att
        ON parent_att.attrelid = parent.oid
       AND parent_att.attnum = parent_key.attnum
      WHERE con.contype = 'f'
        AND child_ns.nspname = ${qLiteral(schema)}
      GROUP BY
        con.oid,
        con.conname,
        child_ns.nspname,
        child.relname,
        parent_ns.nspname,
        parent.relname,
        con.confupdtype,
        con.confdeltype
      ORDER BY child.relname, con.conname;
    `),
    uniqueConstraints: regexEscape(`
      SELECT
        t.relname AS table_name,
        i.indisprimary AS is_primary,
        string_agg(a.attname, ',' ORDER BY idx_key.ordinality) AS column_names
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS idx_key(attnum, ordinality)
      JOIN pg_attribute a
        ON a.attrelid = t.oid
       AND a.attnum = idx_key.attnum
      WHERE n.nspname = ${qLiteral(schema)}
        AND i.indisunique
        AND idx_key.ordinality <= i.indnkeyatts
        AND idx_key.attnum > 0
      GROUP BY t.relname, i.indexrelid, i.indisprimary
      ORDER BY t.relname, i.indexrelid;
    `),
  };
}
