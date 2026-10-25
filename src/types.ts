import type { JSX } from "preact";
import { ColumnMeta } from "./lib/tauri";

export type NavId = "connections" | "keychain" | "logs";

export type ConnectionOpenLogEntry = {
  id: string;
  tabId: string;
  profileId: string;
  profileLabel: string;
  engine: DatabaseEngine;
  host: string;
  dbUser?: string;
  deviceName: string;
  openedAt: number;
  closedAt?: number;
  status: "active" | "closed" | "failed";
  error?: string;
};
export type ViewMode = "grid" | "list";
export type ConnectionSortMode =
  | "label-asc"
  | "label-desc"
  | "created-desc"
  | "created-asc";
export type KeychainSortMode = "label-asc" | "label-desc";
export type TabViewMode = "left" | "right" | "bottom";
export type WindowType =
  | "table"
  | "sql"
  | "explain"
  | "erd"
  | "db-catalog"
  | "db-object-manager";

export type SqlQuery = {
  sql: string;
  timestamp: Date;
  /** How it ran; absent for ordinary Run (and in older entries). */
  kind?: "explain_analyze";
};

export type NavItem = {
  id: NavId;
  label: string;
  icon: JSX.Element;
};

export type TableItem = {
  schema: string;
  name: string;
  new?: boolean;
  kind?: "table" | "view";
  owner?: string;
  estimatedRow?: number | string;
  totalSize?: string;
  dataSize?: string;
  indexSize?: string;
  comment?: string;
};

export type OpenTable = {
  id: string;
  table: TableItem;
};

export type OpenWindowBase = {
  id: string;
  type: WindowType;
  connectionId?: string;
};

export type DatabaseObjectKind = "function" | "procedure" | "trigger";

export type DatabaseObjectCapability = {
  canList: boolean;
  canReadDefinition: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  reason?: string;
};

export type DatabaseObjectItem = {
  id: string;
  kind: DatabaseObjectKind;
  schema: string;
  name: string;
  signature?: string;
  tableName?: string;
  enabled?: boolean;
  engine: DatabaseEngine;
  capability: DatabaseObjectCapability;
};

export type DatabaseObjectDefinition = {
  item: DatabaseObjectItem;
  sql: string;
};

export type TableWindow = OpenWindowBase & {
  type: "table";
  table: TableItem;
};

export type SqlEditorWindow = OpenWindowBase & {
  type: "sql";
  title?: string; // "Query 1", "Untitled SQL", ...
  content: string; // SQL text
  lastRunAt?: number;
};

export type DatabaseObjectManagerWindow = OpenWindowBase & {
  type: "db-object-manager";
  title?: string;
  initialKind?: DatabaseObjectKind;
  initialObjectId?: string;
  /** Unsaved SQL edits (amber in LeftNav), like table patches. */
  dirty?: boolean;
};

export type DatabaseCatalogKind =
  | "tables"
  | "views"
  | "functions"
  | "procedures"
  | "triggers";

export type DatabaseCatalogWindow = OpenWindowBase & {
  type: "db-catalog";
  title?: string;
  catalogKind: DatabaseCatalogKind;
  schema?: string;
};

export type OpenWindow =
  | TableWindow
  | SqlEditorWindow
  | DatabaseCatalogWindow
  | DatabaseObjectManagerWindow;

export type TableData = {
  columns: ColumnMeta[];
  rows: any[][];
  rowCount: number;
};

export type DatabaseEngine =
  | "postgres"
  | "mysql"
  | "redis"
  | "mariadb"
  | "sqlserver"
  | "mongo"
  | "sqlite"
  | "d1"
  | "turso"
  | "oracle"
  | "snowflake"
  | "duckdb"
  | "cassandra"
  | "clickhouse"
  | "google_sheets";

export type DatabaseType = {
  engine: DatabaseEngine;
  label: string;
  abbreviation: string;
  color: string;
  available: boolean;
  desc?: string;
};

export type TableSizeInfo = {
  totalSize: string;
  dataSize: string;
  indexSize: string;
};

export type TableStructure = {
  column_name: string;
  data_type: string;
  is_nullable: boolean | string;
  check: string;
  column_default: string;
  foreign_key: string;
  comment: string;
  extra?: string;
  /** MySQL/MariaDB: the catalog has no default (not an empty string). */
  default_is_null?: boolean;
  /** MySQL/MariaDB column collation (to restate it in MODIFY COLUMN). */
  collation?: string;
  is_identity?: boolean;
  isNew?: boolean;
};

export type TableConstraint = {
  index_name: string;
  index_algorithm: string;
  is_unique: boolean | string;
  is_primary?: boolean | string;
  column_name: string;
  condition?: string;
  include?: string;
  comment?: string;
  /** MySQL: a column indexed by prefix (name(10)). */
  has_prefix?: boolean;
  /** MySQL: a column indexed in descending order. */
  has_descending?: boolean;
  /** MySQL: a functional index part (an expression, not a column). */
  has_expression?: boolean;
  isNew?: boolean;
};

/** Foreign key constraint (for display in dialog: Table, Columns, Referenced Table, On Update/Delete) */
export type ForeignKeyInfo = {
  constraint_name: string;
  table_schema: string;
  table_name: string;
  column_names: string;
  ref_table_schema: string;
  ref_table_name: string;
  ref_column_names: string;
  on_update: string;
  on_delete: string;
};

export type TableColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string; // "NULL" | "NOT NULL"
  column_default: string;
};

export type AiColumnMetadata = {
  name: string;
  dataType?: string;
  nullable?: string;
  defaultValue?: string;
  primaryKey?: boolean;
  comment?: string;
};

export type Pagination = {
  startIndex: number;
  endIndex: number;
  totalRows: number;
  totalPages: number;
};

export type DatabaseConfig = {
  dataTypes: readonly string[];
  indexAlgorithms: readonly string[];
  allowFk?: boolean;
  isBeta?: boolean;
};

export type TableForeignKey = {
  schema: string;
  table: string;
  column: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  parts?: ChatMessagePart[];
  /** True while the assistant message is still being streamed from the model. */
  streaming?: boolean;
  createdAt?: number;
  durationMs?: number;
  sql?: string;
  /**
   * The AI agent queried database data for this answer (plan ai-agent R5). From this
   * message on, the chat counts as holding that connection's data: it is sent only
   * while data-access consent holds for the provider in use.
   */
  dataRead?: boolean;
  assumptions?: string[];
  clarification?: string;
  resultPreview?: Record<string, unknown>[];
  rowCount?: number | null;
  /** The SQL preview part whose run produced `resultPreview`; unset: shown at the end. */
  resultPartIndex?: number;
  confidence?: "high" | "medium" | "low";
};

export type AiProviderKind =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "grok"
  | "groq"
  | "deepseek"
  | "github_copilot"
  | "ollama";

export type AiProviderConfig = {
  id: string;
  kind: AiProviderKind;
  label: string;
  baseUrl?: string | null;
  host?: string | null;
  subPath?: string | null;
  defaultModel: string;
  models?: string[];
  apiKeyRef?: string | null;
  enabled: boolean;
  isDefault?: boolean;
  /** Ollama only: the agent's context size in tokens; empty means the default. */
  contextSize?: number | null;
};

export type AiChatSession = {
  id: string;
  scopeKey: string;
  title?: string;
  providerId?: string | null;
  replyLanguageCode?: string | null;
  targetTable?: string | null;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

export type ChatMessagePart =
  | { type: "text"; text: string }
  | {
      /** The agent needs the user's permission to read data (plan ai-agent R5). */
      type: "dataAccessRequest";
      question: string;
      /** Saved connection name, from the backend. */
      label?: string;
      state?: "pending" | "allowed" | "declined";
    }
  | {
      type: "sqlPreview";
      sql: string;
      safety?: "read_only" | "mutating" | "ddl" | "unknown";
      /**
       * Suggested by the AI agent. `safety` then only describes the check made when
       * the answer arrived: Run re-checks the SQL against the current connection.
       */
      agent?: boolean;
      confirmationState?:
        | "pending"
        | "inserted"
        | "running"
        | "ran"
        | "canceled"
        | "error";
      error?: string;
    }
  | {
      type: "actionPreview";
      action: string;
      label: string;
      payload?: Record<string, unknown>;
      confirmationState?: "pending" | "confirmed" | "canceled" | "error";
      error?: string;
    }
  | {
      type: "resultPreview";
      rows: Record<string, unknown>[];
      rowCount?: number | null;
      confidence?: "high" | "medium" | "low";
    }
  | { type: "error"; message: string }
  | {
      /** What an AI agent run looked at (plan ai-agent R6): no arguments or data. */
      type: "agentSteps";
      steps: AgentStepSummary[];
    };

export type AgentStepSummary = {
  tool: string;
  ok: boolean;
  truncated: boolean;
  durationMs: number;
};
