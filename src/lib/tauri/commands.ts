export const CMD = {
  // AI providers
  aiProviderList: "ai_provider_list",
  aiProviderSave: "ai_provider_save",
  aiProviderDelete: "ai_provider_delete",
  aiProviderListModels: "ai_provider_list_models",
  aiProviderCancelListModels: "ai_provider_cancel_list_models",
  aiProviderTestDraft: "ai_provider_test_draft",
  aiOllamaStatus: "ai_ollama_status",
  aiLegacyModelInfo: "ai_legacy_model_info",
  aiLegacyModelDelete: "ai_legacy_model_delete",
  aiChatComplete: "ai_chat_complete",
  aiChatCancel: "ai_chat_cancel",
  // AI agent (plan .agent/plans/ai-agent.md)
  aiAgentStart: "ai_agent_start",
  aiAgentCancel: "ai_agent_cancel",
  aiAgentSqlSafety: "ai_agent_sql_safety",
  aiAgentDataAccessStatus: "ai_agent_data_access_status",
  aiAgentDataAccessGrant: "ai_agent_data_access_grant",
  aiAgentDataAccessList: "ai_agent_data_access_list",
  aiAgentDataAccessRevoke: "ai_agent_data_access_revoke",
  healthInspectorSignalBackend: "health_inspector_signal_backend",
  postgresInstanceAppName: "postgres_instance_app_name",
  licenseDeviceInfo: "license_device_info",
  licenseStateLoad: "license_state_load",
  licenseStateSave: "license_state_save",
  licenseStateClear: "license_state_clear",
  licenseTrialSync: "license_trial_sync",
  licenseActivate: "license_activate",
  licenseRefresh: "license_refresh",
  licenseDeactivate: "license_deactivate",
  licenseOpenExternalUrl: "license_open_external_url",
  updaterInstallIfAllowed: "updater_install_if_allowed",
  securityTouchIdAuthenticate: "security_touch_id_authenticate",
  legacyWebStorageRead: "legacy_web_storage_read",

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

  // PostgreSQL sessions held across calls
  sqlSessionBegin: "sql_session_begin",
  sqlSessionExecute: "sql_session_execute",
  sqlSessionEnd: "sql_session_end",
  sqlSessionCancel: "sql_session_cancel",
  backupFileBegin: "backup_file_begin",
  backupFileWrite: "backup_file_write",
  backupFilePublish: "backup_file_publish",
  backupFileAbort: "backup_file_abort",
  backupFileForget: "backup_file_forget",

  // Draft sql management
  draftSqlLoad: "sql_draft_load",
  draftSqlSave: "sql_draft_save",
  draftSqlClear: "sql_draft_clear",
  draftSqlGC: "sql_draft_gc",

  // Snippet library
  snippetsLoad: "snippets_load",
  snippetsSave: "snippets_save",

  // Persistent storage
  persistentLoad: "persistent_load",
  persistentSave: "persistent_save",
  persistentClear: "persistent_clear",

  // Export (streaming append + scoped temp session)
  exportAppendToFile: "export_append_to_file",
  exportSessionBegin: "export_session_begin",
  exportSessionAppend: "export_session_append",
  exportSessionPublish: "export_session_publish",
  exportSessionAbort: "export_session_abort",

  // Mongo
  cassandraListKeyspaces: "cassandra_list_keyspaces",
  cassandraListTables: "cassandra_list_tables",
  cassandraTableOverview: "cassandra_table_overview",
  cassandraFetchRows: "cassandra_fetch_rows",
  cassandraPrimaryKeyColumns: "cassandra_primary_key_columns",
  cassandraUpdateRows: "cassandra_update_rows",
  googleSheetsListSheets: "google_sheets_list_sheets",
  googleSheetsSheetOverview: "google_sheets_sheet_overview",
  googleSheetsFetchRows: "google_sheets_fetch_rows",
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
