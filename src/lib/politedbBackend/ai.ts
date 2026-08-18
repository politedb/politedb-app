import { licenseStateLoad } from "src/lib/tauri";
import type { ChatMessagePart, DatabaseEngine, TableItem } from "src/types";

const POLITEDB_API_BASE = (import.meta.env.VITE_POLITEDB_API_BASE ?? "").trim();

export type PoliteDbAiIntent =
  | "general_chat"
  | "generate_sql"
  | "explain_sql"
  | "optimize_sql"
  | "explain_schema"
  | "fix_error"
  | "generate_migration";

export type PoliteDbAiChatRequest = {
  message: string;
  intent?: PoliteDbAiIntent;
  connectionId?: string;
  databaseType?: "postgres" | "mysql" | "sqlite" | "mongodb" | "redis";
  activeDatabase?: string;
  activeSchema?: string;
  activeTable?: string;
  currentSql?: string;
  selectedColumns?: string[];
  selectedRows?: unknown[];
  sqlError?: string;
};

export type PoliteDbAiChatResponse = {
  requestId: string;
  text: string;
  intent: PoliteDbAiIntent;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  cacheHit: boolean;
};

export type PoliteDbAiGatewayContext = {
  workspaceId?: string;
  connectionId?: string;
  engine?: DatabaseEngine;
  activeDatabase?: string;
  activeSchema?: string;
  activeTable?: string;
  currentSql?: string;
  selectedModel?: string;
  intent?: PoliteDbAiIntent;
  tables?: TableItem[];
  columnsByTable?: Record<string, string[]>;
};

export type PoliteDbAiModelOption = {
  id: string;
  label: string;
  apiModel: string;
  provider: string;
};

export type PoliteDbAiModelProvider = {
  provider: string;
  label: string;
  defaultModel: string | null;
  models: string[];
  modelOptions: PoliteDbAiModelOption[];
};

export type PoliteDbAiModelsResponse = {
  defaultProvider: string | null;
  defaultModel: string | null;
  dailyRequestsLimit: number;
  dailyTokensLimit: number;
  providers: PoliteDbAiModelProvider[];
  supportedTools: string[];
};

export type PoliteDbAiArtifact =
  | {
      type: "sql";
      title: string;
      sql: string;
      dialect?: string | null;
      description?: string | null;
    }
  | {
      type: "migration";
      title: string;
      sql: string;
      dialect?: string | null;
      notes?: string | null;
    }
  | {
      type: "index_advice";
      title: string;
      content: string;
      ddl?: string | null;
      riskLevel?: "safe" | "medium" | "dangerous" | null;
    }
  | {
      type: "explanation";
      title: string;
      content: string;
    };

export type PoliteDbAiToolProposal = {
  id: string;
  toolName: string;
  status: string;
  reason: string;
  confirmationLabel: string;
  arguments: Record<string, unknown>;
  result?: Record<string, unknown> | null;
};

export type PoliteDbAiStreamResult = {
  text: string;
  artifacts: PoliteDbAiArtifact[];
  toolProposals: PoliteDbAiToolProposal[];
};

export function isPoliteDbAiGatewayEnabled() {
  return Boolean(POLITEDB_API_BASE);
}

export function mapEngineToBackendDatabaseType(
  engine?: DatabaseEngine
): PoliteDbAiChatRequest["databaseType"] {
  if (
    engine === "postgres" ||
    engine === "mysql" ||
    engine === "sqlite" ||
    engine === "redis"
  ) {
    return engine;
  }
  if (engine === "mariadb") return "mysql";
  if (engine === "mongo") return "mongodb";
  return undefined;
}

function apiUrl(path: string) {
  const base = POLITEDB_API_BASE.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/api") && suffix.startsWith("/api/")) {
    return `${base}${suffix.slice("/api".length)}`;
  }
  return `${base}${suffix}`;
}

function stableThreadId(context?: PoliteDbAiGatewayContext) {
  const raw = `${context?.workspaceId || "global"}:${context?.connectionId || "global"}`;
  return `desktop_${btoa(unescape(encodeURIComponent(raw)))
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 48)}`;
}

function planFromLicensePlanName(planName?: string | null) {
  return String(planName ?? "")
    .trim()
    .toLowerCase() === "ultimate"
    ? "ultimate"
    : "free";
}

async function aiHeaders(workspaceId?: string) {
  const license = await licenseStateLoad().catch(() => null);
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-user-id":
      license?.license_id ||
      license?.device_id ||
      license?.device_name ||
      "anonymous",
    "x-workspace-id": workspaceId || "politedb-desktop",
    "x-user-plan": planFromLicensePlanName(license?.plan_name),
  };
}

async function readGatewayError(res: Response) {
  const text = await res.text().catch(() => "");
  if (!text.trim()) {
    return `POLITEDB_AI_REQUEST_FAILED: ${res.status} ${res.statusText}`;
  }
  try {
    const parsed = JSON.parse(text);
    const code = String(parsed?.code ?? "POLITEDB_AI_REQUEST_FAILED");
    const message = String(parsed?.message ?? res.statusText);
    return `${code}: ${message}`;
  } catch {
    return `POLITEDB_AI_REQUEST_FAILED: ${res.status} ${res.statusText} - ${text
      .replace(/\s+/g, " ")
      .slice(0, 280)}`;
  }
}

function buildRequest(
  message: string,
  context?: PoliteDbAiGatewayContext
): PoliteDbAiChatRequest {
  return {
    message,
    intent: context?.intent,
    connectionId: context?.connectionId,
    databaseType: mapEngineToBackendDatabaseType(context?.engine),
    activeSchema: context?.activeSchema,
    currentSql: context?.currentSql,
  };
}

function buildSchemaContext(context?: PoliteDbAiGatewayContext) {
  const tables = (context?.tables ?? [])
    .filter(
      (table) => !context?.activeSchema || table.schema === context.activeSchema
    )
    .slice(0, 80)
    .map((table) => {
      const key = `${table.schema}.${table.name}`;
      return {
        schema: table.schema,
        name: table.name,
        comment: table.comment ?? null,
        columns: (context?.columnsByTable?.[key] ?? [])
          .slice(0, 120)
          .map((name) => ({
            name,
            type: null,
          })),
        indexes: [],
        foreignKeys: [],
      };
    });
  return { tables };
}

function buildTurnRequest(message: string, context?: PoliteDbAiGatewayContext) {
  return {
    userMessage: message,
    intent: context?.intent,
    model: context?.selectedModel,
    workspaceId: context?.workspaceId || "politedb-desktop",
    connectionId: context?.connectionId || "global-ai-assistant",
    editorContext: {
      currentSql: context?.currentSql ?? null,
      selectedSql: null,
      activeDatabase: context?.activeDatabase ?? null,
      activeSchema: context?.activeSchema ?? null,
      activeTable: context?.activeTable ?? null,
      activeTab: null,
    },
    schemaContext: buildSchemaContext(context),
    queryHistory: [],
    docsContext: [],
    allowedTools: [
      "open_table",
      "create_tab",
      "export_csv",
      "explain_index",
      "generate_migration",
    ],
  };
}

export async function politeDbAiChat(
  message: string,
  context?: PoliteDbAiGatewayContext,
  signal?: AbortSignal
) {
  const res = await fetch(apiUrl("/api/ai/chat"), {
    method: "POST",
    signal,
    headers: await aiHeaders(context?.workspaceId),
    body: JSON.stringify(buildRequest(message, context)),
  });

  if (!res.ok) {
    throw new Error(await readGatewayError(res));
  }

  return (await res.json()) as PoliteDbAiChatResponse;
}

export async function politeDbAiChatStream(args: {
  message: string;
  context?: PoliteDbAiGatewayContext;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}) {
  const res = await fetch(apiUrl("/api/ai/chat/stream"), {
    method: "POST",
    signal: args.signal,
    headers: {
      ...(await aiHeaders(args.context?.workspaceId)),
      Accept: "text/event-stream",
    },
    body: JSON.stringify(buildRequest(args.message, args.context)),
  });

  if (!res.ok) {
    throw new Error(await readGatewayError(res));
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("POLITEDB_AI_STREAM_FAILED: empty body");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const eventText of events) {
      const lines = eventText.split("\n");
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim();
      const dataText = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");

      if (!event || !dataText) continue;
      const data = JSON.parse(dataText);

      if (event === "token") {
        text += String(data?.text ?? "");
        args.onDelta?.(text);
      } else if (event === "error") {
        throw new Error(String(data?.error ?? "POLITEDB_AI_STREAM_FAILED"));
      }
    }
  }

  return text.trim();
}

export async function politeDbAiListModels(workspaceId?: string) {
  const res = await fetch(apiUrl("/api/ai/models"), {
    headers: await aiHeaders(workspaceId),
  });
  if (!res.ok) throw new Error(await readGatewayError(res));
  return (await res.json()) as PoliteDbAiModelsResponse;
}

export async function politeDbAiThreadStream(args: {
  message: string;
  context?: PoliteDbAiGatewayContext;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}) {
  const threadId = stableThreadId(args.context);
  const headers = await aiHeaders(args.context?.workspaceId);
  const threadBody = {
    threadId,
    workspaceId: args.context?.workspaceId || "politedb-desktop",
    connectionId: args.context?.connectionId || "global-ai-assistant",
    title: "PoliteDB AI",
    model: args.context?.selectedModel,
  };

  const threadRes = await fetch(apiUrl("/api/ai/threads"), {
    method: "POST",
    signal: args.signal,
    headers,
    body: JSON.stringify(threadBody),
  });
  if (!threadRes.ok) {
    throw new Error(await readGatewayError(threadRes));
  }

  const res = await fetch(apiUrl(`/api/ai/threads/${threadId}/stream`), {
    method: "POST",
    signal: args.signal,
    headers: {
      ...headers,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(buildTurnRequest(args.message, args.context)),
  });
  if (!res.ok) {
    throw new Error(await readGatewayError(res));
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("POLITEDB_AI_STREAM_FAILED: empty body");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let artifacts: PoliteDbAiArtifact[] = [];
  let toolProposals: PoliteDbAiToolProposal[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const eventText of events) {
      const lines = eventText.split("\n");
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim();
      const dataText = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (!event || !dataText) continue;
      const data = JSON.parse(dataText);
      if (event === "token") {
        text += String(data?.text ?? "");
        args.onDelta?.(text);
      } else if (event === "done") {
        artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
        toolProposals = Array.isArray(data?.toolProposals)
          ? data.toolProposals
          : [];
      } else if (event === "error") {
        throw new Error(String(data?.error ?? "POLITEDB_AI_STREAM_FAILED"));
      }
    }
  }

  return { text: text.trim(), artifacts, toolProposals };
}

export function artifactsToMessageParts(
  text: string,
  artifacts: PoliteDbAiArtifact[]
): ChatMessagePart[] {
  const parts: ChatMessagePart[] = text ? [{ type: "text", text }] : [];
  for (const artifact of artifacts) {
    if (artifact.type === "sql") {
      parts.push({
        type: "sqlPreview",
        sql: artifact.sql,
        safety: "unknown",
        confirmationState: "pending",
      });
    } else if (artifact.type === "migration") {
      parts.push({
        type: "text",
        text: [artifact.title, artifact.notes].filter(Boolean).join("\n"),
      });
      parts.push({
        type: "sqlPreview",
        sql: artifact.sql,
        safety: "ddl",
        confirmationState: "pending",
      });
    } else if (artifact.type === "index_advice") {
      parts.push({
        type: "text",
        text: artifact.content,
      });
      if (artifact.ddl) {
        parts.push({
          type: "sqlPreview",
          sql: artifact.ddl,
          safety: "ddl",
          confirmationState: "pending",
        });
      }
    } else if (artifact.type === "explanation") {
      parts.push({ type: "text", text: artifact.content });
    }
  }
  return parts;
}

export async function politeDbAiIndexStatus(context: PoliteDbAiGatewayContext) {
  if (!context.connectionId) return null;
  const params = new URLSearchParams();
  params.set("workspaceId", context.workspaceId || "politedb-desktop");
  if (context.activeDatabase)
    params.set("databaseName", context.activeDatabase);
  if (context.activeSchema) params.set("schemaName", context.activeSchema);
  if (context.engine) params.set("engine", context.engine);
  const res = await fetch(
    apiUrl(
      `/api/ai/index/connections/${encodeURIComponent(context.connectionId)}/status?${params}`
    ),
    { headers: await aiHeaders(context.workspaceId) }
  );
  if (!res.ok) throw new Error(await readGatewayError(res));
  return await res.json();
}

export async function politeDbAiEnableIndex(context: PoliteDbAiGatewayContext) {
  if (!context.connectionId) throw new Error("AI_CONNECTION_ID_REQUIRED");
  const res = await fetch(
    apiUrl(
      `/api/ai/index/connections/${encodeURIComponent(context.connectionId)}/enable`
    ),
    {
      method: "POST",
      headers: await aiHeaders(context.workspaceId),
      body: JSON.stringify({
        workspaceId: context.workspaceId || "politedb-desktop",
        databaseName: context.activeDatabase ?? null,
        schemaName: context.activeSchema ?? null,
        engine: context.engine ?? null,
      }),
    }
  );
  if (!res.ok) throw new Error(await readGatewayError(res));
  return await res.json();
}

export async function politeDbAiClearIndex(context: PoliteDbAiGatewayContext) {
  if (!context.connectionId) throw new Error("AI_CONNECTION_ID_REQUIRED");
  const params = new URLSearchParams();
  params.set("workspaceId", context.workspaceId || "politedb-desktop");
  if (context.activeDatabase)
    params.set("databaseName", context.activeDatabase);
  if (context.activeSchema) params.set("schemaName", context.activeSchema);
  if (context.engine) params.set("engine", context.engine);
  const res = await fetch(
    apiUrl(
      `/api/ai/index/connections/${encodeURIComponent(context.connectionId)}?${params}`
    ),
    {
      method: "DELETE",
      headers: await aiHeaders(context.workspaceId),
    }
  );
  if (!res.ok) throw new Error(await readGatewayError(res));
  return await res.json();
}

export async function politeDbAiIndexSchema(context: PoliteDbAiGatewayContext) {
  if (!context.connectionId) throw new Error("AI_CONNECTION_ID_REQUIRED");
  const res = await fetch(apiUrl("/api/ai/index/schema"), {
    method: "POST",
    headers: await aiHeaders(context.workspaceId),
    body: JSON.stringify({
      workspaceId: context.workspaceId || "politedb-desktop",
      connectionId: context.connectionId,
      databaseName: context.activeDatabase ?? null,
      schemaName: context.activeSchema ?? null,
      engine: context.engine ?? null,
      schemaContext: buildSchemaContext(context),
    }),
  });
  if (!res.ok) throw new Error(await readGatewayError(res));
  return await res.json();
}
