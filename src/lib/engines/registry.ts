import type { DatabaseEngine } from "src/types";

export type DefaultSchemaContext = {
  currentDatabase?: string;
  redisDb?: number;
};

const ENGINES_WITHOUT_DEFAULT_CREDENTIALS = new Set<DatabaseEngine>([
  "mongo",
  "cassandra",
  "sqlite",
  "duckdb",
  "d1",
  "turso",
]);

const NON_SQL_PATCH_ENGINES = new Set<DatabaseEngine>([
  "mongo",
  "cassandra",
  "redis",
]);

const EMPTY_COLUMN_OK_ENGINES = new Set<DatabaseEngine>(["mongo", "cassandra"]);

export function resolveDefaultSchema(
  engine: DatabaseEngine | undefined,
  ctx: DefaultSchemaContext = {}
): string {
  switch (engine) {
    case "postgres":
      return "public";
    case "redis":
      return `db ${ctx.redisDb ?? 0}`;
    case "sqlite":
    case "d1":
    case "turso":
      return "main";
    case "clickhouse":
    case "cassandra":
      return ctx.currentDatabase || "default";
    default:
      return "";
  }
}

export function supportsTableMeta(engine: DatabaseEngine | undefined): boolean {
  return engine !== "redis" && engine !== "mongo" && engine !== "cassandra";
}

export function isNonSqlPatchEngine(
  engine: DatabaseEngine | undefined
): engine is "mongo" | "cassandra" | "redis" {
  return !!engine && NON_SQL_PATCH_ENGINES.has(engine);
}

export function allowsEmptyColumnList(
  engine: DatabaseEngine | undefined
): boolean {
  return !!engine && EMPTY_COLUMN_OK_ENGINES.has(engine);
}

export function supportsNewSchema(engine: DatabaseEngine | undefined): boolean {
  return engine === "postgres";
}

export function defaultCredentialUser(engine: DatabaseEngine): string {
  return ENGINES_WITHOUT_DEFAULT_CREDENTIALS.has(engine) ? "" : "root";
}

export function defaultCredentialDatabase(engine: DatabaseEngine): string {
  return ENGINES_WITHOUT_DEFAULT_CREDENTIALS.has(engine) ? "" : "root";
}

export function formatTableBreadcrumbTarget(
  engine: DatabaseEngine | undefined,
  schema: string,
  table: string
): string {
  if (!table) return "";
  return engine === "postgres" ? `${schema}.${table}` : table;
}

export function preferredSchemaFromList(
  engine: DatabaseEngine | undefined,
  schemas: string[],
  defaultSchema: string
): string | undefined {
  if (defaultSchema && schemas.includes(defaultSchema)) return defaultSchema;
  if (engine === "postgres" && schemas.includes("public")) return "public";
  return schemas[0];
}
