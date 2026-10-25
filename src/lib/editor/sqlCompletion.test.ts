import { describe, it, expect, vi, beforeEach } from "vitest";

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
      // Word split for test: letters/numbers/underscore, scanned backwards
      // (linear, like Monaco).
      let start = pos.column - 1;
      while (start > 0 && /[a-zA-Z0-9_]/.test(value[start - 1]!)) start--;
      return { startColumn: start + 1, endColumn: pos.column };
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

  it("after semicolon: second statement gets statement keywords, not previous FROM tables", () => {
    const tables: TableItem[] = [
      { schema: "public", name: "SequelizeMeta" },
      { schema: "public", name: "Setting" },
      { schema: "public", name: "User" },
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

    const afterSemi = provide(provider, 'SELECT * FROM public."User"; ');
    expect(afterSemi.suggestions.map((s: any) => s.label)).toContain("SELECT");
    expect(afterSemi.suggestions.map((s: any) => s.label)).not.toContain(
      "SequelizeMeta"
    );

    const partial = provide(provider, 'SELECT * FROM public."User"; SE');
    const partialLabels = partial.suggestions.map((s: any) => s.label);
    expect(partialLabels).toContain("SELECT");
    expect(partialLabels).not.toContain("SequelizeMeta");
    expect(partialLabels).not.toContain("Setting");
  });

  it("after semicolon: SELECT clause is parsed from the current statement only", () => {
    const tables: TableItem[] = [{ schema: "public", name: "users" }];
    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables,
      columnsByTable: { "public.users": ["id"] },
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;
    const res = provide(provider, "SELECT * FROM users; SELECT ");
    const labels = res.suggestions.map((s: any) => s.label);

    expect(labels).toContain("*");
    expect(labels).toContain("FROM");
    expect(labels).toContain("COUNT");
    expect(labels).not.toContain("users");
  });

  it("semicolon inside a string does not start a new statement", () => {
    const getCtx = () => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [{ schema: "public", name: "users" }],
      columnsByTable: {},
      engine: "postgres" as DatabaseEngine,
    });

    const disposable: any = registerSqlCompletionSmart(getCtx);
    const provider = disposable.__provider;
    const res = provide(provider, "SELECT * FROM users WHERE name = ';'; SE");
    const labels = res.suggestions.map((s: any) => s.label);

    expect(labels).toContain("SELECT");
    expect(labels).not.toContain("users");
  });
});

describe("sqlCompletionSmart reported and latent issues", () => {
  function providerFor(extra: Record<string, unknown> = {}) {
    (monaco.languages.registerCompletionItemProvider as any).mockClear();
    const disposable: any = registerSqlCompletionSmart(() => ({
      schemas: ["public", "sales"],
      activeSchema: "public",
      tables: [
        { schema: "public", name: "addresses" },
        { schema: "public", name: "users" },
        { schema: "public", name: "user" },
        { schema: "sales", name: "orders" },
      ],
      columnsByTable: {
        "public.users": ["id", "email"],
        "public.addresses": ["id", "line1"],
        "sales.orders": ["id", "total"],
      },
      engine: "postgres" as DatabaseEngine,
      ...extra,
    }));
    return disposable.__provider;
  }
  /** Suggestions with the cursor at `|`. */
  function at(provider: any, sqlWithCursor: string) {
    const column = sqlWithCursor.indexOf("|") + 1;
    const sql = sqlWithCursor.replace("|", "");
    const model = createModel(sql);
    return provider.provideCompletionItems(
      model,
      new (monaco as any).Position(1, column)
    ).suggestions as any[];
  }
  const inserts = (items: any[]) =>
    Object.fromEntries(items.map((s) => [s.label, s.insertText]));
  const labels = (items: any[]) => items.map((s) => s.label);

  it("1. after schema. inserts only the table name", () => {
    expect(inserts(at(providerFor(), "SELECT * FROM public.|")).addresses).toBe(
      "addresses"
    );
    expect(inserts(at(providerFor(), "SELECT * FROM sales.|")).orders).toBe(
      "orders"
    );
    // Also without an active schema.
    const noActive = providerFor({ activeSchema: undefined });
    expect(inserts(at(noActive, "SELECT * FROM public.ad|")).addresses).toBe(
      "addresses"
    );
  });

  it("2. suggests columns after FROM table WHERE", () => {
    const items = labels(at(providerFor(), "SELECT * FROM users WHERE |"));
    expect(items).toContain("email");
    expect(items).not.toContain("GROUP BY");
  });

  it("3. keeps suggesting tables while a table name is typed", () => {
    const items = labels(at(providerFor(), "SELECT * FROM us|"));
    expect(items).toContain("users");
    expect(items).not.toContain("WHERE");
  });

  it("4. resolves unqualified tables in the active schema (MySQL, SQLite)", () => {
    const mysql = providerFor({
      schemas: ["shop"],
      activeSchema: undefined,
      tables: [{ schema: "shop", name: "users" }],
      columnsByTable: { "shop.users": ["id", "email"] },
      engine: "mysql",
    });
    expect(labels(at(mysql, "SELECT * FROM users u WHERE u.|"))).toContain(
      "email"
    );
    expect(labels(at(mysql, "SELECT * FROM users WHERE |"))).toContain("email");
  });

  it("5. matches an alias in any case and inserts it as written", () => {
    expect(
      labels(at(providerFor(), "SELECT * FROM users U WHERE u.|"))
    ).toEqual(["id", "email"]);
    const items = at(providerFor(), "SELECT * FROM users U WHERE |");
    expect(inserts(items)["U.email"]).toBe("U.email");
  });

  it("6. knows every table of a comma-separated FROM", () => {
    expect(
      labels(at(providerFor(), "SELECT * FROM addresses a, users u WHERE u.|"))
    ).toEqual(["id", "email"]);
    expect(labels(at(providerFor(), "SELECT * FROM addresses a, |"))).toContain(
      "users"
    );
  });

  it("7. understands a quoted schema before the dot", () => {
    expect(inserts(at(providerFor(), 'SELECT * FROM "sales".|'))).toEqual({
      orders: "orders",
    });
  });

  it("8. matches keywords as whole words only, outside strings", () => {
    const items = labels(at(providerFor(), "SELECT reason, |"));
    expect(items).toContain("FROM");
    expect(items).toContain("*");
    const inString = labels(
      at(providerFor(), "SELECT * FROM users WHERE email = 'from x' AND |")
    );
    expect(inString).toContain("email");
  });

  it("9. suggests columns of tables named after the cursor", () => {
    const items = labels(at(providerFor(), "SELECT | FROM users"));
    expect(items).toContain("email");
  });

  it("10. quotes table names that are reserved words", () => {
    expect(inserts(at(providerFor(), "SELECT * FROM |")).user).toBe('"user"');
    expect(inserts(at(providerFor(), "SELECT * FROM |")).users).toBe("users");
    const mysql = providerFor({
      schemas: ["shop"],
      activeSchema: "shop",
      tables: [{ schema: "shop", name: "order" }],
      columnsByTable: {},
      engine: "mysql",
    });
    expect(inserts(at(mysql, "SELECT * FROM |")).order).toBe("`order`");
  });
});

describe("sqlCompletionSmart scopes, lexing and dialects", () => {
  const BASE = {
    schemas: ["public"],
    activeSchema: "public",
    tables: [
      { schema: "public", name: "users" },
      { schema: "public", name: "orders" },
    ],
    columnsByTable: {
      "public.users": ["id", "email"],
      "public.orders": ["id", "total"],
    },
    engine: "postgres" as DatabaseEngine,
  };
  function providerFor(extra: Record<string, unknown> = {}) {
    (monaco.languages.registerCompletionItemProvider as any).mockClear();
    const disposable: any = registerSqlCompletionSmart(() => ({
      ...BASE,
      ...extra,
    }));
    return disposable.__provider;
  }
  function at(sqlWithCursor: string, extra: Record<string, unknown> = {}) {
    const column = sqlWithCursor.indexOf("|") + 1;
    const model = createModel(sqlWithCursor.replace("|", ""));
    return providerFor(extra).provideCompletionItems(
      model,
      new (monaco as any).Position(1, column)
    ).suggestions as any[];
  }
  const inserts = (items: any[]) =>
    Object.fromEntries(items.map((s) => [s.label, s.insertText]));
  const labels = (items: any[]) => items.map((s) => s.label);

  it("keeps a quoted alias quoted and tells quoted aliases apart", () => {
    expect(inserts(at('SELECT * FROM users "U" WHERE |'))['"U".email']).toBe(
      '"U".email'
    );
    const both = 'SELECT * FROM users "U", orders "u" WHERE ';
    expect(labels(at(`${both}"U".|`))).toEqual(["id", "email"]);
    expect(labels(at(`${both}"u".|`))).toEqual(["id", "total"]);
    // An unquoted alias still matches in any case and is inserted as written.
    expect(labels(at("SELECT * FROM users U WHERE u.|"))).toEqual([
      "id",
      "email",
    ]);
  });

  it("keeps a bracketed SQL Server alias as written", () => {
    const sqlserver = {
      schemas: ["dbo"],
      activeSchema: "dbo",
      tables: [{ schema: "dbo", name: "users" }],
      columnsByTable: { "dbo.users": ["id", "email"] },
      engine: "sqlserver",
    };
    const items = at("SELECT * FROM users [my alias] WHERE |", sqlserver);
    expect(inserts(items)["[my alias].email"]).toBe("[my alias].email");
    expect(
      labels(at("SELECT * FROM users [my alias] WHERE [my alias].|", sqlserver))
    ).toEqual(["id", "email"]);
  });

  it("ignores table names inside string literals", () => {
    const items = labels(at("SELECT |, 'from orders' FROM users"));
    expect(items).toContain("email");
    expect(items).not.toContain("total");
  });

  it("uses only the cursor's UNION branch", () => {
    const first = labels(at("SELECT | FROM users UNION SELECT * FROM orders"));
    expect(first).toContain("email");
    expect(first).not.toContain("total");
    const second = labels(at("SELECT * FROM users UNION SELECT | FROM orders"));
    expect(second).toContain("total");
    expect(second).not.toContain("email");
  });

  it("scopes subqueries: inner tables stay inside, outer ones are visible", () => {
    const inner = labels(
      at("SELECT * FROM users u WHERE u.id IN (SELECT | FROM orders o)")
    );
    expect(inner).toContain("total");
    expect(inner).not.toContain("email");
    // A correlated reference to the outer alias.
    expect(
      labels(
        at(
          "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE u.|)"
        )
      )
    ).toEqual(["id", "email"]);
    // The subquery's alias is not visible outside it.
    expect(
      labels(at("SELECT o.| FROM users WHERE id IN (SELECT id FROM orders o)"))
    ).not.toContain("total");
    // Function parentheses are not a scope.
    expect(labels(at("SELECT count(|) FROM users"))).toContain("email");
  });

  it("does not take tables from a CTE body into the main query", () => {
    const items = labels(
      at("WITH recent AS (SELECT * FROM orders) SELECT | FROM users")
    );
    expect(items).toContain("email");
    expect(items).not.toContain("total");
    expect(
      labels(at("WITH recent AS (SELECT | FROM orders) SELECT * FROM users"))
    ).toContain("total");
  });

  it("finds the statement end past dollar quotes, comments and escapes", () => {
    expect(labels(at("SELECT |, $$;$$ FROM users"))).toContain("email");
    expect(labels(at("SELECT |, $tag$ ; $tag$ FROM users"))).toContain("email");
    expect(labels(at("SELECT | /* /* ; */ ; */ FROM users"))).toContain(
      "email"
    );
    const next = labels(
      at("SELECT | /* ' */ FROM users; SELECT * FROM orders")
    );
    expect(next).toContain("email");
    expect(next).not.toContain("total");
    expect(labels(at("SELECT |, E'it\\'s; ok' FROM users"))).toContain("email");
    const mysql = {
      schemas: ["shop"],
      activeSchema: "shop",
      tables: [{ schema: "shop", name: "users" }],
      columnsByTable: { "shop.users": ["id", "email"] },
      engine: "mysql",
    };
    expect(labels(at("SELECT |, 'it\\'s;' FROM users", mysql))).toContain(
      "email"
    );
    expect(labels(at('SELECT |, "a;b" FROM users', mysql))).toContain("email");
    expect(labels(at("SELECT | # ;\n FROM users", mysql))).toContain("email");
    const sqlserver = {
      schemas: ["dbo"],
      activeSchema: "dbo",
      tables: [{ schema: "dbo", name: "we;ird]" }],
      columnsByTable: { "dbo.we;ird]": ["id", "note"] },
      engine: "sqlserver",
    };
    expect(labels(at("SELECT | FROM [we;ird]]]", sqlserver))).toContain("note");
  });

  it("suggests nothing inside a string literal or a comment", () => {
    expect(at("SELECT * FROM users WHERE email = 'ab|")).toEqual([]);
    expect(at("SELECT * FROM users WHERE email = 'a|b'")).toEqual([]);
    expect(at("SELECT /* | ' */ FROM users; SELECT * FROM orders")).toEqual([]);
    expect(at("SELECT * FROM users -- note|")).toEqual([]);
    expect(at("SELECT $$ x | $$")).toEqual([]);
    // Right after a closed literal is code again.
    expect(labels(at("SELECT * FROM users WHERE email = 'a' AND |"))).toContain(
      "email"
    );
  });

  it("quotes reserved table names per dialect", () => {
    const one = (engine: string, schema: string, name: string) => ({
      schemas: [schema],
      activeSchema: schema,
      tables: [{ schema, name }],
      columnsByTable: {},
      engine,
    });
    expect(
      inserts(at("SELECT * FROM |", one("sqlite", "main", "index")))
    ).toEqual({
      index: '"index"',
    });
    expect(
      inserts(at("SELECT * FROM |", one("sqlserver", "dbo", "select")))
    ).toEqual({
      select: "[select]",
    });
    expect(
      inserts(at("SELECT * FROM |", one("sqlserver", "dbo", "a]b")))
    ).toEqual({
      "a]b": "[a]]b]",
    });
    expect(
      inserts(at("SELECT * FROM |", one("sqlserver", "dbo", "users")))
    ).toEqual({
      users: "users",
    });
    expect(
      inserts(at("SELECT * FROM |", one("mysql", "shop", "over")))
    ).toEqual({
      over: "`over`",
    });
    expect(
      inserts(at("SELECT * FROM |", one("postgres", "public", "left")))
    ).toEqual({
      left: '"left"',
    });
  });

  it("quotes reserved column names per dialect", () => {
    const items = at("SELECT * FROM t WHERE |", {
      schemas: ["dbo"],
      activeSchema: "dbo",
      tables: [{ schema: "dbo", name: "t" }],
      columnsByTable: { "dbo.t": ["order", "name"] },
      engine: "sqlserver",
    });
    expect(inserts(items).order).toBe("[order]");
  });
});

describe("sqlCompletionSmart quoted names, shadowing and large input", () => {
  function at(sqlWithCursor: string) {
    (monaco.languages.registerCompletionItemProvider as any).mockClear();
    const disposable: any = registerSqlCompletionSmart(() => ({
      schemas: ["public"],
      activeSchema: "public",
      tables: [
        { schema: "public", name: "users" },
        { schema: "public", name: "orders" },
      ],
      columnsByTable: {
        "public.users": ["id", "email"],
        "public.orders": ["id", "total"],
      },
      engine: "postgres" as DatabaseEngine,
    }));
    const column = sqlWithCursor.indexOf("|") + 1;
    const model = createModel(sqlWithCursor.replace("|", ""));
    return disposable.__provider.provideCompletionItems(
      model,
      new (monaco as any).Position(1, column)
    ).suggestions as any[];
  }
  const inserts = (items: any[]) =>
    Object.fromEntries(items.map((s) => [s.label, s.insertText]));
  const labels = (items: any[]) => items.map((s) => s.label);

  it("accepts a quoted alias that is a reserved word", () => {
    const where = inserts(at('SELECT * FROM users "order" WHERE |'));
    expect(where['"order".email']).toBe('"order".email');
    expect(where["users.email"]).toBeUndefined();
    expect(labels(at('SELECT * FROM users "order" WHERE "order".|'))).toEqual([
      "id",
      "email",
    ]);
  });

  it("lets the inner alias shadow an equal outer one, quoted or not", () => {
    expect(
      labels(
        at(
          'SELECT * FROM users "u" WHERE EXISTS (SELECT * FROM orders u WHERE "u".|)'
        )
      )
    ).toEqual(["id", "total"]);
    expect(
      labels(
        at(
          'SELECT * FROM users u WHERE EXISTS (SELECT * FROM orders "u" WHERE u.|)'
        )
      )
    ).toEqual(["id", "total"]);
    // Outside the subquery the outer alias is used.
    expect(
      labels(
        at('SELECT "u".| FROM users "u" WHERE EXISTS (SELECT * FROM orders u)')
      )
    ).toEqual(["id", "email"]);
  });

  it("ignores keywords inside quoted names", () => {
    const from = labels(at('SELECT |, "from orders" FROM users'));
    expect(from).toContain("email");
    expect(from).not.toContain("total");
    for (const word of ["union", "intersect", "except"]) {
      expect(labels(at(`SELECT |, "${word}" FROM users`))).toContain("email");
    }
    const join = labels(at('SELECT | FROM users "join orders"'));
    expect(join).toContain("email");
    expect(join).not.toContain("total");
  });

  it("finds subqueries after any whitespace", () => {
    const padded = labels(
      at(
        `SELECT | FROM users WHERE EXISTS (${" ".repeat(70)}SELECT * FROM orders)`
      )
    );
    expect(padded).toContain("email");
    expect(padded).not.toContain("total");
    const multiline = labels(
      at("SELECT | FROM users WHERE EXISTS (\n\n   \n  SELECT * FROM orders)")
    );
    expect(multiline).not.toContain("total");
  });

  it("reads the statement end far below the cursor", () => {
    expect(labels(at(`SELECT |${" ".repeat(21_000)}FROM users`))).toContain(
      "email"
    );
  });

  it("stays fast on a very long word", () => {
    const started = performance.now();
    at(`SELECT ${"x".repeat(100_000)} |`);
    at(`SELECT ${"a.".repeat(5_000)}a |`);
    at(`SELECT ${'"x".'.repeat(5_000)} |`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("stays fast and correct for densely nested subqueries", () => {
    const depth = 20_000;
    const sql =
      "SELECT (".repeat(depth) + "SELECT | FROM orders" + ")".repeat(depth);
    const started = performance.now();
    const items = labels(at(sql));
    expect(performance.now() - started).toBeLessThan(500);
    expect(items).toContain("total");
    expect(items).not.toContain("email");
  });
});
