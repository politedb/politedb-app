import type {
  DatabaseEngine,
  DatabaseObjectCapability,
  DatabaseObjectDefinition,
  DatabaseObjectItem,
  DatabaseObjectKind,
} from "src/types";
import type { QueryResult } from "src/lib/tauri/types";
import { qIdent, qLiteral } from "src/lib/queries/sql/shared";
import { runSqlQuery } from "src/lib/tauri/query";
import { cellToString } from "src/utils/convert";

type CapabilityKey = `${DatabaseEngine}:${DatabaseObjectKind}`;

const UNSUPPORTED_REASON =
  "This object type is not supported for this engine yet.";

const capabilityMap: Partial<Record<CapabilityKey, DatabaseObjectCapability>> =
  {
    "postgres:function": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "postgres:procedure": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "postgres:trigger": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "mysql:function": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "mysql:procedure": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "mysql:trigger": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "mariadb:function": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "mariadb:procedure": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "mariadb:trigger": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "sqlite:trigger": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "d1:trigger": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
    "turso:trigger": {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
  };

function defaultCapability(
  engine: DatabaseEngine,
  kind: DatabaseObjectKind
): DatabaseObjectCapability {
  return (
    capabilityMap[`${engine}:${kind}`] ?? {
      canList: false,
      canReadDefinition: false,
      canCreate: false,
      canEdit: false,
      canDelete: false,
      reason: UNSUPPORTED_REASON,
    }
  );
}

export function getDatabaseObjectCapability(
  engine: DatabaseEngine,
  kind: DatabaseObjectKind
): DatabaseObjectCapability {
  return defaultCapability(engine, kind);
}

export function makeDatabaseObjectId(args: {
  kind: DatabaseObjectKind;
  schema: string;
  name: string;
  signature?: string;
  tableName?: string;
}) {
  const signature = args.signature?.trim() ?? "";
  const tableName = args.tableName?.trim() ?? "";
  return `${args.kind}:${args.schema}:${args.name}:${signature}:${tableName}`;
}

export function buildDatabaseObjectItem(args: {
  engine: DatabaseEngine;
  kind: DatabaseObjectKind;
  schema: string;
  name: string;
  signature?: string;
  tableName?: string;
  enabled?: boolean;
}): DatabaseObjectItem {
  const capability = getDatabaseObjectCapability(args.engine, args.kind);
  return {
    id: makeDatabaseObjectId(args),
    kind: args.kind,
    schema: args.schema,
    name: args.name,
    signature: args.signature,
    tableName: args.tableName,
    enabled: args.enabled,
    engine: args.engine,
    capability,
  };
}

export function parseDatabaseObjectsFromRows(args: {
  engine: DatabaseEngine;
  rows: unknown[][];
}): DatabaseObjectItem[] {
  const { engine, rows } = args;
  return rows
    .map((row) => {
      const schema = cellToString(row?.[0]) ?? "";
      const name = cellToString(row?.[1]) ?? "";
      const rawKind = (cellToString(row?.[2]) ?? "").trim().toLowerCase();
      const signature = cellToString(row?.[3]) ?? "";
      const tableName = cellToString(row?.[4]) ?? "";
      const enabledRaw = (cellToString(row?.[5]) ?? "").trim().toLowerCase();

      if (!schema || !name) return null;
      if (
        rawKind !== "function" &&
        rawKind !== "procedure" &&
        rawKind !== "trigger"
      ) {
        return null;
      }

      return buildDatabaseObjectItem({
        engine,
        kind: rawKind,
        schema,
        name,
        signature,
        tableName,
        enabled:
          enabledRaw === ""
            ? undefined
            : enabledRaw === "true" ||
              enabledRaw === "1" ||
              enabledRaw === "o" ||
              enabledRaw === "enabled",
      });
    })
    .filter((item): item is DatabaseObjectItem => Boolean(item))
    .filter((item) => item.capability.canList);
}

function firstRowObject(result: QueryResult) {
  const row = result.rows?.[0] ?? [];
  return Object.fromEntries(
    result.columns.map((column, index) => [column.name, row[index]])
  );
}

function normalizeDefinitionResult(result: QueryResult, candidates: string[]) {
  const row = firstRowObject(result);
  for (const key of candidates) {
    const value = cellToString((row as Record<string, unknown>)[key], true);
    if (value && value.trim()) return value.trim();
  }

  for (const cell of result.rows?.[0] ?? []) {
    const value = cellToString(cell, true);
    if (value && value.trim()) return value.trim();
  }

  return "";
}

export async function loadDatabaseObjectDefinition(args: {
  engine: DatabaseEngine;
  connectionId: string;
  item: DatabaseObjectItem;
}): Promise<DatabaseObjectDefinition> {
  const { engine, connectionId, item } = args;
  let sql = "";

  if (engine === "postgres") {
    if (item.kind === "trigger") {
      const result = await runSqlQuery(
        connectionId,
        `
        SELECT pg_get_triggerdef(t.oid, true) || ';' AS definition
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal
          AND n.nspname = ${qLiteral(item.schema, engine)}
          AND c.relname = ${qLiteral(item.tableName ?? "", engine)}
          AND t.tgname = ${qLiteral(item.name, engine)}
        LIMIT 1;
      `
      );
      sql = normalizeDefinitionResult(result, ["definition"]);
    } else {
      const prokind = item.kind === "procedure" ? "p" : "f";
      const result = await runSqlQuery(
        connectionId,
        `
        SELECT pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${qLiteral(item.schema, engine)}
          AND p.proname = ${qLiteral(item.name, engine)}
          AND p.prokind = ${qLiteral(prokind, engine)}
          AND pg_get_function_identity_arguments(p.oid) = ${qLiteral(item.signature ?? "", engine)}
        LIMIT 1;
      `
      );
      sql = normalizeDefinitionResult(result, ["definition"]);
    }
  } else if (engine === "mysql" || engine === "mariadb") {
    if (item.kind === "trigger") {
      const result = await runSqlQuery(
        connectionId,
        `SHOW CREATE TRIGGER ${qIdent(item.schema, engine)}.${qIdent(item.name, engine)};`
      );
      sql = normalizeDefinitionResult(result, [
        "SQL Original Statement",
        "Create Trigger",
        "create statement",
      ]);
    } else if (item.kind === "procedure") {
      const result = await runSqlQuery(
        connectionId,
        `SHOW CREATE PROCEDURE ${qIdent(item.schema, engine)}.${qIdent(item.name, engine)};`
      );
      sql = normalizeDefinitionResult(result, [
        "Create Procedure",
        "create statement",
      ]);
    } else {
      const result = await runSqlQuery(
        connectionId,
        `SHOW CREATE FUNCTION ${qIdent(item.schema, engine)}.${qIdent(item.name, engine)};`
      );
      sql = normalizeDefinitionResult(result, [
        "Create Function",
        "create statement",
      ]);
    }
  } else if (engine === "sqlite" || engine === "d1" || engine === "turso") {
    if (item.kind !== "trigger") {
      throw new Error("Definition is not supported for this object type.");
    }
    const result = await runSqlQuery(
      connectionId,
      `
      SELECT sql AS definition
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name = ${qLiteral(item.name, engine)}
      LIMIT 1;
    `
    );
    sql = normalizeDefinitionResult(result, ["definition", "sql"]);
  } else {
    throw new Error(UNSUPPORTED_REASON);
  }

  if (!sql.trim()) {
    throw new Error("Object definition could not be loaded.");
  }

  return { item, sql };
}

export function buildCreateDatabaseObjectTemplate(args: {
  engine: DatabaseEngine;
  kind: DatabaseObjectKind;
  schema: string;
  name: string;
  tableName?: string;
}) {
  const { engine, kind, schema, name, tableName } = args;
  const objectName =
    engine === "sqlite" || engine === "d1" || engine === "turso"
      ? qIdent(name, engine)
      : `${qIdent(schema, engine)}.${qIdent(name, engine)}`;

  const targetTable =
    engine === "sqlite" || engine === "d1" || engine === "turso"
      ? qIdent(tableName || "table_name", engine)
      : `${qIdent(schema, engine)}.${qIdent(tableName || "table_name", engine)}`;

  if (engine === "postgres") {
    if (kind === "function") {
      return `CREATE OR REPLACE FUNCTION ${objectName}()\nRETURNS void\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- TODO\nEND;\n$$;`;
    }
    if (kind === "procedure") {
      return `CREATE OR REPLACE PROCEDURE ${objectName}()\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- TODO\nEND;\n$$;`;
    }
    return `CREATE TRIGGER ${qIdent(name, engine)}\nAFTER INSERT ON ${targetTable}\nFOR EACH ROW\nEXECUTE FUNCTION ${qIdent(schema, engine)}.${qIdent(`handle_${name}`, engine)}();`;
  }

  if (engine === "mysql" || engine === "mariadb") {
    if (kind === "function") {
      return `CREATE FUNCTION ${objectName}()\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN 0;\nEND;`;
    }
    if (kind === "procedure") {
      return `CREATE PROCEDURE ${objectName}()\nBEGIN\n  SELECT 1;\nEND;`;
    }
    return `CREATE TRIGGER ${objectName}\nBEFORE INSERT ON ${targetTable}\nFOR EACH ROW\nBEGIN\n  -- SET NEW.column_name = value;\nEND;`;
  }

  if (engine === "sqlite" || engine === "d1" || engine === "turso") {
    if (kind !== "trigger") {
      return "-- This object type is not supported for this engine yet.";
    }
    return `CREATE TRIGGER ${qIdent(name, engine)}\nAFTER INSERT ON ${targetTable}\nBEGIN\n  -- SQL statements\nEND;`;
  }

  return `-- ${UNSUPPORTED_REASON}`;
}

export function buildDropDatabaseObjectSql(args: {
  engine: DatabaseEngine;
  item: DatabaseObjectItem;
}) {
  const { engine, item } = args;

  if (item.kind === "trigger") {
    if (engine === "postgres") {
      return `DROP TRIGGER IF EXISTS ${qIdent(item.name, engine)} ON ${qIdent(item.schema, engine)}.${qIdent(item.tableName ?? "", engine)};`;
    }
    if (engine === "mysql" || engine === "mariadb") {
      return `DROP TRIGGER IF EXISTS ${qIdent(item.schema, engine)}.${qIdent(item.name, engine)};`;
    }
    if (engine === "sqlite" || engine === "d1" || engine === "turso") {
      return `DROP TRIGGER IF EXISTS ${qIdent(item.name, engine)};`;
    }
  }

  const signature = (item.signature ?? "").trim();
  if (engine === "postgres") {
    const name = `${qIdent(item.schema, engine)}.${qIdent(item.name, engine)}`;
    const suffix = signature ? `(${signature})` : "()";
    return `DROP ${item.kind.toUpperCase()} IF EXISTS ${name}${suffix};`;
  }

  if (engine === "mysql" || engine === "mariadb") {
    return `DROP ${item.kind.toUpperCase()} IF EXISTS ${qIdent(item.schema, engine)}.${qIdent(item.name, engine)};`;
  }

  return `-- ${UNSUPPORTED_REASON}`;
}

export function buildSaveStatements(args: {
  engine: DatabaseEngine;
  item: DatabaseObjectItem | null;
  sql: string;
}) {
  const body = args.sql.trim();
  if (!body) return [];

  if (!args.item) return [body];

  if (args.item.kind === "trigger") {
    return [
      buildDropDatabaseObjectSql({ engine: args.engine, item: args.item }),
      body,
    ];
  }

  if (
    (args.engine === "mysql" || args.engine === "mariadb") &&
    !/\bcreate\s+(or\s+replace\s+)?(function|procedure)\b/i.test(body)
  ) {
    return [
      buildDropDatabaseObjectSql({ engine: args.engine, item: args.item }),
      body,
    ];
  }

  return [body];
}

export function objectKindLabel(kind: DatabaseObjectKind) {
  if (kind === "function") return "Functions";
  if (kind === "procedure") return "Procedures";
  return "Triggers";
}

export function objectKindSingular(kind: DatabaseObjectKind) {
  if (kind === "function") return "function";
  if (kind === "procedure") return "procedure";
  return "trigger";
}
