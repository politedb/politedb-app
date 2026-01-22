export const CMD = {
  // Connection
  connectionTest: "connection_test",
  connectionList: "connection_list",
  connectionRemove: "connection_remove",

  // Profiles
  profileList: "profile_list",
  profileRemove: "profile_remove",
  profileSave: "profile_save",
  profileSaveAndConnect: "profile_save_and_connect",
  profileConnect: "profile_connect",
  profileConnectTest: "profile_connect_test",

  // Secrets
  secretsGet: "secrets_get",
  secretsSet: "secrets_set",
  secretsDelete: "secrets_delete",

  // Operations
  operationExecute: "operation_execute",
  operationCancel: "operation_cancel",
  operationChunkAck: "operation_chunk_ack",

  // Draft sql management
  draftSqlLoad: "sql_draft_load",
  draftSqlSave: "sql_draft_save",
  draftSqlClear: "sql_draft_clear",
  draftSqlGC: "sql_draft_gc",

  // Persistent storage
  persistentLoad: "persistent_load",
  persistentSave: "persistent_save",
  persistentClear: "persistent_clear",
} as const;

export type CommandName = (typeof CMD)[keyof typeof CMD];
