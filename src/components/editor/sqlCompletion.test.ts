import { describe, it, expect, vi, beforeEach } from "vitest";

// ✅ Mock monaco-editor (minimal surface needed)
vi.mock("monaco-editor", () => {
  class Range {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
    constructor(sl: number, sc: number, el: number, ec: number) {
      this.startLineNumber = sl;
      this.startColumn = sc;
      this.endLineNumber = el;
      this.endColumn = ec;
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
    Field: 4,
    Struct: 23,
    Class: 7,
  };

  const languages = {
    CompletionItemKind,
    registerCompletionItemProvider: vi.fn(),
  };

  return {
    Range,
    Position,
    languages,
    editor: {},
  };
});

import * as monaco from "monaco-editor";
import { registerSqlCompletionSmart } from "./sqlCompletion";
import { DatabaseEngine, TableItem } from "src/types";

function makeModel(text: string) {
  return {
    getValue: () => text,
    getOffsetAt: (_pos: any) => text.length, // cursor at end
    getWordUntilPosition: (_pos: any) => ({
      startColumn: text.length + 1,
      endColumn: text.length + 1,
    }),
  } as any;
}

function getProvider() {
  const calls = (monaco as any).languages.registerCompletionItemProvider.mock
    .calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![1];
}

function provide(text: string, _ctx: any) {
  const model = makeModel(text);
  const pos = new (monaco as any).Position(1, text.length + 1);
  const provider = getProvider();
  return provider.provideCompletionItems(model, pos, undefined, undefined);
}

const KW_LIGHT = [
  "SELECT",
  "FROM",
  "WHERE",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "AND",
  "OR",
  "ON",
  "AS",
  "INSERT",
  "UPDATE",
  "DELETE",
];

const POST_FROM_KW = [
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
];

const POST_JOIN_KW = [
  "ON",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "WHERE",
  "GROUP BY",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
];

describe("registerSqlCompletionSmart", () => {
  beforeEach(() => {
    (monaco as any).languages.registerCompletionItemProvider.mockClear();
  });

  it("registers provider for sql with trigger characters", () => {
    registerSqlCompletionSmart(() => ({
      schemas: [],
      tables: [],
      columnsByTable: {},
    }));

    expect(
      (monaco as any).languages.registerCompletionItemProvider
    ).toHaveBeenCalledTimes(1);

    const [, provider] = (monaco as any).languages
      .registerCompletionItemProvider.mock.calls[0];

    expect(provider.triggerCharacters).toEqual([".", "_", " ", ";"]);
    expect(typeof provider.provideCompletionItems).toBe("function");
  });

  it("returns KW_LIGHT at statement boundary (empty / new statement)", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    }));

    const res = provide("", null);
    const labels = res.suggestions.map((s: any) => s.label);
    expect(labels).toEqual(KW_LIGHT);
  });

  it("DOT: suggests alias columns as alias.col", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [{ schema: "public", name: "users" }],
      columnsByTable: { "public.users": ["id", "email"] },
      engine: "postgres" as DatabaseEngine,
    }));

    // alias "u" for users, then u.
    const sql = "SELECT * FROM users u WHERE u.";
    const res = provide(sql, null);

    const labels = res.suggestions.map((s: any) => s.label);
    expect(labels).toEqual(["u.id", "u.email"]);

    // insertText should be alias."col" when PG needs quoting (here safe -> no quote)
    const inserts = res.suggestions.map((s: any) => s.insertText);
    expect(inserts).toEqual(["u.id", "u.email"]);
  });

  it("DOT: suggests schema tables after schema.", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public", "auth"],
      activeSchema: "public",
      tables: [
        { schema: "public", name: "users" },
        { schema: "public", name: "orders" },
        { schema: "auth", name: "sessions" },
      ],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    }));

    const res = provide("SELECT * FROM public.", null);
    const labels = res.suggestions.map((s: any) => s.label);
    expect(labels).toEqual(["users", "orders"]);

    // insertText should be public.<table> (quoted if needed)
    const inserts = res.suggestions.map((s: any) => s.insertText);
    expect(inserts).toEqual(["public.users", "public.orders"]);
  });

  it("POST_FROM_TABLE: suggests POST_FROM_KW right after FROM <table> [alias]", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [{ schema: "public", name: "users" }],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    }));

    const res1 = provide("SELECT * FROM users ", null);
    expect(res1.suggestions.map((s: any) => s.label)).toEqual(POST_FROM_KW);

    const res2 = provide("SELECT * FROM users u ", null);
    expect(res2.suggestions.map((s: any) => s.label)).toEqual(POST_FROM_KW);
  });

  it("POST_JOIN_TABLE: suggests POST_JOIN_KW right after JOIN <table> [alias]", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [{ schema: "public", name: "users" }],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    }));

    const res1 = provide("JOIN users ", null);
    expect(res1.suggestions.map((s: any) => s.label)).toEqual(POST_JOIN_KW);

    const res2 = provide("JOIN users u ", null);
    expect(res2.suggestions.map((s: any) => s.label)).toEqual(POST_JOIN_KW);
  });

  it("EXPECT_TABLE: suggests tables with schema prefix when not active schema", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public", "auth"],
      activeSchema: "public",
      tables: [
        { schema: "public", name: "users" },
        { schema: "auth", name: "sessions" },
      ],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    }));

    const res = provide("SELECT * FROM ", null);
    const labels = res.suggestions.map((s: any) => s.label);
    expect(labels).toEqual(["users", "auth.sessions"]);

    const inserts = res.suggestions.map((s: any) => s.insertText);
    expect(inserts).toEqual(["users", "auth.sessions"]);
  });

  it("EXPECT_TABLE: quotes identifiers based on engine (mysql backticks)", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [
        { schema: "public", name: "User Sessions", kind: "table" } as TableItem,
      ],
      columnsByTable: {},
      engine: "mysql" as DatabaseEngine,
    }));

    const res = provide("SELECT * FROM ", null);
    expect(res.suggestions[0].label).toBe("User Sessions");
    expect(res.suggestions[0].insertText).toBe("`User Sessions`");
  });

  it("EXPECT_COLUMN: suggests columns from last table + operators/keywords/functions", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [{ schema: "public", name: "users" }],
      columnsByTable: { "public.users": ["id", "email"] },
      engine: "postgres" as DatabaseEngine,
    }));

    const res = provide("SELECT * FROM users WHERE a = ", null);
    const labels = res.suggestions.map((s: any) => s.label);

    // columns first
    expect(labels.slice(0, 2)).toEqual(["id", "email"]);

    // some known operators/functions/kw appear later
    expect(labels).toContain("=");
    expect(labels).toContain("IN");
    expect(labels).toContain("COUNT");
    expect(labels).toContain("SELECT");
  });

  it("DEFAULT: returns KW_LIGHT when not in a special context", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    }));

    const res = provide("hello ", null);
    expect(res.suggestions.map((s: any) => s.label)).toEqual(KW_LIGHT);
  });

  it("uses CompletionItemKind icons (Keyword/Field/Struct/Class) as expected", () => {
    registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [
        { schema: "public", name: "users" },
        { schema: "public", name: "v_users", kind: "view" },
      ],
      columnsByTable: { "public.users": ["id"] },
      engine: "postgres" as DatabaseEngine,
    }));

    const resTables = provide("SELECT * FROM ", null);
    const users = resTables.suggestions.find((s: any) => s.label === "users");
    const view = resTables.suggestions.find((s: any) => s.label === "v_users");
    expect(users.kind).toBe(
      (monaco as any).languages.CompletionItemKind.Struct
    );
    expect(view.kind).toBe((monaco as any).languages.CompletionItemKind.Class);

    const resCols = provide("SELECT * FROM users WHERE a =", null);
    const id = resCols.suggestions.find((s: any) => s.label === "id");
    expect(id.kind).toBe((monaco as any).languages.CompletionItemKind.Field);
  });
});
