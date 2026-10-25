import { qLiteral, regexEscape } from "./shared";

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

// has_prefix, has_descending, has_expression and index_comment are what
// dropping and recreating the index would lose. No SQL line comments here:
// regexEscape joins the query into one line.
export const tableConstraintsMySqlQuery = (
  schema: string,
  tableName: string
) => {
  const queryStr = `
    SELECT
      index_name,
      index_type,
      non_unique,
      CASE WHEN UPPER(index_name) = 'PRIMARY' THEN 'true' ELSE 'false' END AS is_primary,
      GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ',') AS column_name,
      MAX(sub_part IS NOT NULL) AS has_prefix,
      MAX(collation = 'D') AS has_descending,
      MAX(column_name IS NULL) AS has_expression,
      MAX(index_comment) AS index_comment
    FROM information_schema.statistics
    WHERE table_schema = ${qLiteral(schema)}
      AND table_name = ${qLiteral(tableName)}
    GROUP BY index_name, index_type, non_unique
    ORDER BY index_name;
  `;
  return regexEscape(queryStr);
};
