export {
  resolveDefaultSchema,
  supportsTableMeta,
  isNonSqlPatchEngine,
  allowsEmptyColumnList,
  supportsNewSchema,
  defaultCredentialUser,
  defaultCredentialDatabase,
  formatTableBreadcrumbTarget,
  preferredSchemaFromList,
} from "./registry";
export type { DefaultSchemaContext } from "./registry";

export * from "./clickhouse";
export * from "./dbConfig";
