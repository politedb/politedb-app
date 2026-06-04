import { qLiteral, regexEscape } from "./shared";

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
