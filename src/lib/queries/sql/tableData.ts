import type { DatabaseEngine } from "src/types";
import { isSqliteLike } from "src/utils/sqliteLike";
import { quoteTableName } from "src/utils/sqlDialect";
import { buildWhereClause, type TableFilterCondition, type TableSort } from "./filters";
import { isMySqlLike, qIdent, qLiteral, regexEscape } from "./shared";

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
  const tableIdent = quoteTableName(schema, tableName, engine);
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
  const tableIdent = quoteTableName(schema, tableName, engine);
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
  const tableIdent = quoteTableName(schema, tableName, engine);
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

  if (engine === "snowflake") {
    const queryStr = `
      SELECT COALESCE(row_count, 0)
      FROM information_schema.tables
      WHERE table_schema = ${qLiteral(schema)}
        AND table_name = ${qLiteral(tableName)}
      LIMIT 1;
    `;
    return regexEscape(queryStr);
  }

  if (engine === "clickhouse") {
    const queryStr = `
      SELECT toInt64(greatest(total_rows, 0))
      FROM system.tables
      WHERE database = currentDatabase()
        AND name = ${qLiteral(tableName)}
      LIMIT 1
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
  if (
    isSqliteLike(engine) ||
    engine === "oracle" ||
    engine === "sqlserver" ||
    engine === "snowflake" ||
    engine === "clickhouse"
  ) {
    return "SELECT 0;";
  }

  const queryStr = `SELECT '${qIdent(schema)}.${qIdent(tableName)}'::regclass::oid;`;
  return regexEscape(queryStr);
};
