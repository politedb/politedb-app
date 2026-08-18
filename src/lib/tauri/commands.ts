export const CMD = {
  // AI runtime
  aiRuntimeStatus: "ai_runtime_status",
  aiRuntimeStart: "ai_runtime_start",
  aiRuntimeStop: "ai_runtime_stop",
  aiRuntimeDownloadDefaultModel: "ai_runtime_download_default_model",
  aiRuntimeCancelModelDownload: "ai_runtime_cancel_model_download",
  aiRuntimeDeleteDefaultModel: "ai_runtime_delete_default_model",
  aiProviderList: "ai_provider_list",
  aiProviderSaveConfig: "ai_provider_save_config",
  aiProviderSetKey: "ai_provider_set_key",
  aiProviderValidateConfig: "ai_provider_validate_config",
  aiProviderDelete: "ai_provider_delete",
  aiProviderTest: "ai_provider_test",
  aiChatComplete: "ai_chat_complete",
  licenseDeviceInfo: "license_device_info",
  licenseStateLoad: "license_state_load",
  licenseStateSave: "license_state_save",
  licenseStateClear: "license_state_clear",
  licenseActivate: "license_activate",
  licenseRefresh: "license_refresh",
  licenseDeactivate: "license_deactivate",
  licenseOpenExternalUrl: "license_open_external_url",
  updaterInstallIfAllowed: "updater_install_if_allowed",
  securityTouchIdAuthenticate: "security_touch_id_authenticate",

  // Connection
  connectionCreate: "connection_create",
  connectionTest: "connection_test",
  connectionList: "connection_list",
  connectionVersion: "connection_version",
  connectionRemove: "connection_remove",

  // Profiles
  profileList: "profile_list",
  profileRemove: "profile_remove",
  profileSave: "profile_save",
  profileSaveAndConnect: "profile_save_and_connect",
  profileConnect: "profile_connect",
  profileConnectTest: "profile_connect_test",
  profileExport: "profile_export",
  profileExportOne: "profile_export_one",
  profileExportOneEncrypted: "profile_export_one_encrypted",
  profileDecryptExport: "profile_decrypt_export",
  profileIsEncryptedExport: "profile_is_encrypted_export",
  profileImport: "profile_import",
  profileImportExternal: "profile_import_external",

  // Secrets
  secretsGet: "secrets_get",
  secretsSet: "secrets_set",
  secretsDelete: "secrets_delete",
  secretsList: "secrets_list",

  // Operations
  operationExecute: "operation_execute",
  operationExecuteTransaction: "operation_execute_transaction",
  operationImportCsvTransaction: "operation_import_csv_transaction",
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

  // Export (streaming append for large table export)
  exportAppendToFile: "export_append_to_file",

  // Mongo
  cassandraListKeyspaces: "cassandra_list_keyspaces",
  cassandraListTables: "cassandra_list_tables",
  cassandraTableOverview: "cassandra_table_overview",
  cassandraFetchRows: "cassandra_fetch_rows",
  cassandraPrimaryKeyColumns: "cassandra_primary_key_columns",
  cassandraUpdateRows: "cassandra_update_rows",
  mongoListDatabases: "mongo_list_databases",
  mongoListCollections: "mongo_list_collections",
  mongoCollectionOverview: "mongo_collection_overview",
  mongoFindDocuments: "mongo_find_documents",
  mongoListIndexes: "mongo_list_indexes",
  mongoCollectionSizeInfo: "mongo_collection_size_info",
  mongoInsertDocuments: "mongo_insert_documents",
  mongoUpdateDocuments: "mongo_update_documents",
  mongoDeleteDocuments: "mongo_delete_documents",
} as const;

export type CommandName = (typeof CMD)[keyof typeof CMD];
