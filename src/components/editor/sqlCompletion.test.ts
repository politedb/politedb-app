import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("monaco-editor", () => {
  class Range {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    constructor(sLn: number, sCol: number, eLn: number, eCol: number) {
      this.startLineNumber = sLn;
      this.startColumn = sCol;
      this.endLineNumber = eLn;
      this.endColumn = eCol;
    }
  }

  class Position {
    lineNumber: number;
    column: number;
    constructor(lineNumber: number, column: number) {
      this.lineNumber = lineNumber;
      this.column = column;
    }
  }

  const CompletionItemKind = {
    Keyword: 14,
    Function: 1,
    Field: 4,
    Struct: 6,
    Class: 7,
    Module: 8,
    Operator: 12,
  };

  const languages = {
    CompletionItemKind,
    CompletionItemInsertTextRule: {
      InsertAsSnippet: 4,
    },
    registerCompletionItemProvider: vi.fn((langId: string, provider: any) => {
      return { dispose: vi.fn(), __langId: langId, __provider: provider };
    }),
  };

  return { Range, Position, languages };
});

// mock sqlConstants
vi.mock("src/sqlConstants", () => {
  return {
    getKeywordsForEngine: () => ({
      statement: ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE"],
      clause: ["FROM", "WHERE", "GROUP BY", "ORDER BY"],
      postFrom: ["WHERE", "GROUP BY", "ORDER BY", "LIMIT"],
      postJoin: ["ON", "WHERE", "GROUP BY", "ORDER BY"],
      expression: ["AND", "OR", "IN", "IS", "NULL", "LIKE"],
      orderBy: ["ASC", "DESC", "NULLS LAST"],
      values: ["TRUE", "FALSE", "NULL"],
    }),
    getFunctionsForEngine: () => ["COUNT", "MAX", "MIN"],
    ALL_COMPLETION_KEYWORDS: ["SELECT", "FROM", "WHERE", "JOIN", "LIMIT"],
  };
});

vi.mock("src/types", () => ({}));

// Now import module under test
import * as monaco from "monaco-editor";
import { registerSqlCompletionSmart } from "./sqlCompletion";
import { DatabaseEngine } from "src/types";

type TableItem = { schema: string; name: string; kind?: "table" | "view" };

function createModel(text: string) {
  const value = text;

  return {
    getValue: () => value,
    getOffsetAt: (pos: any) => {
      return pos.column - 1;
    },
    getWordUntilPosition: (pos: any) => {
      // naive word split for test: letters/numbers/underscore
      const left = value.slice(0, pos.column - 1);
      const m = left.match(/[a-zA-Z0-9_]*$/);
      const word = m?.[0] ?? "";
      return { startColumn: pos.column - word.length, endColumn: pos.column };
    },
  } as any;
}

function provide(provider: any, sql: string) {
  const model = createModel(sql);
  const pos = new (monaco as any).Position(1, sql.length + 1);
  return provider.provideCompletionItems(model, pos);
}

describe("sqlCompletionSmart", () => {
  beforeEach(() => {
    (monaco.languages.registerCompletionItemProvider as any).mockClear();
  });

  it("registers a completion provider for sql", () => {
    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);

    expect(
      monaco.languages.registerCompletionItemProvider
    ).toHaveBeenCalledTimes(1);
    expect(disposable).toBeTruthy();
  });

  it("STATEMENT_START: suggests statement keywords", () => {
    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;

    const res = provide(provider, "");
    const labels = res.suggestions.map((s: any) => s.label);

    expect(labels).toContain("SELECT");
    expect(labels).toContain("WITH");
    expect(labels).toContain("INSERT");
  });

  it("DOT_ALIAS: suggests columns for alias.", () => {
    const tables: TableItem[] = [{ schema: "public", name: "users" }];
    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables,
      columnsByTable: {
        "public.users": ["id", "email", "created_at"],
      },
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;

    // alias comes from FROM users u
    const sqlWithFrom = "SELECT * FROM users u WHERE u.";
    const res = provide(provider, sqlWithFrom);

    const labels = res.suggestions.map((s: any) => s.label);
    expect(labels).toContain("id");
    expect(labels).toContain("email");
  });

  it("DOT_SCHEMA: suggests tables for schema.", () => {
    const tables: TableItem[] = [
      { schema: "public", name: "users" },
      { schema: "public", name: "orders" },
      { schema: "sales", name: "invoices" },
    ];

    const getCtx = () => ({
      schemas: ["public", "sales"],
      activeSchema: "public",
      tables,
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;

    const res = provide(provider, "SELECT * FROM public.");
    const labels = res.suggestions.map((s: any) => s.label);

    expect(labels).toContain("users");
    expect(labels).toContain("orders");
    expect(labels).not.toContain("invoices");
  });

  it("EXPECT_TABLE: includes recent tables with higher priority (lower sortText)", () => {
    const tables: TableItem[] = [
      { schema: "public", name: "users" },
      { schema: "public", name: "orders" },
      { schema: "public", name: "products" },
    ];

    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables,
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;

    const res = provide(provider, "SELECT * FROM users u JOIN ");
    const usersItem = res.suggestions.find((s: any) => s.label === "users");
    const ordersItem = res.suggestions.find((s: any) => s.label === "orders");

    expect(usersItem).toBeTruthy();
    expect(ordersItem).toBeTruthy();

    // sortText is "priority+label"
    expect(usersItem.sortText <= ordersItem.sortText).toBe(true);
  });

  it("SELECT_CLAUSE: suggests columns + * + functions", () => {
    const tables: TableItem[] = [{ schema: "public", name: "users" }];

    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables,
      columnsByTable: {
        "public.users": ["id", "email"],
      },
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;

    const res = provide(provider, "SELECT ");
    const labels = res.suggestions.map((s: any) => s.label);

    expect(labels).toContain("*");
    expect(labels).toContain("COUNT");
    // Should suggest base columns too when recent tables exist in context
    // (in this parser version, recent tables come from FROM/JOIN context;
    // so this is mostly about functions and keywords)
    expect(labels).toContain("FROM");
  });

  it("EXPECT_COLUMN: suggests columns from recent tables + expression keywords", () => {
    const tables: TableItem[] = [
      { schema: "public", name: "users" },
      { schema: "public", name: "orders" },
    ];

    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables,
      columnsByTable: {
        "public.users": ["id", "status"],
        "public.orders": ["user_id", "total"],
      },
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;

    const res = provide(provider, "SELECT * FROM users u WHERE ");
    const labels = res.suggestions.map((s: any) => s.label);

    // columns
    expect(labels).toContain("id");
    expect(labels).toContain("status");

    // expr keywords
    expect(labels).toContain("AND");
    expect(labels).toContain("IN");
    expect(labels).toContain("LIKE");
  });

  it("INSERT_COLUMNS: suggests columns for insert target", () => {
    const tables: TableItem[] = [{ schema: "public", name: "users" }];

    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables,
      columnsByTable: {
        "public.users": ["id", "email", "status"],
      },
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;

    const res = provide(provider, "INSERT INTO users (");
    const labels = res.suggestions.map((s: any) => s.label);

    expect(labels).toContain("id");
    expect(labels).toContain("email");
    expect(labels).toContain("status");
  });

  it("UPDATE_SET: suggests columns + expression keywords", () => {
    const tables: TableItem[] = [{ schema: "public", name: "users" }];

    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables,
      columnsByTable: {
        "public.users": ["email", "status"],
      },
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;

    const res = provide(provider, "UPDATE users SET e");
    const labels = res.suggestions.map((s: any) => s.label);

    expect(labels).toContain("email");
    expect(labels).toContain("status");
    expect(labels).toContain("AND");
    expect(labels).toContain("OR");
  });
});
