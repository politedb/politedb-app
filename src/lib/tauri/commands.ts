export const CMD = {
  // Connection
  connectionCreate: "connection_create",
  connectionTest: "connection_test",
  connectionList: "connection_list",
  connectionRemove: "connection_remove",

  // Profiles
  profileCreate: "profile_create",
  profileList: "profile_list",
  profileUpdate: "profile_update",
  profileRemove: "profile_remove",
  profileSaveAndConnect: "profile_save_and_connect",
  profileConnect: "profile_connect",

  // Secrets
  secretsGet: "secrets_get",
  secretsSet: "secrets_set",
  secretsDelete: "secrets_delete",

  // Operations
  operationExecute: "operation_execute",
  operationCancel: "operation_cancel",
} as const;

export type CommandName = (typeof CMD)[keyof typeof CMD];
