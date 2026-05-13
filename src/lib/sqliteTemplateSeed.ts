import { runSqlQuery } from "src/lib/tauri/query";

/**
 * DDL + seed rows for the in-memory SQLite template connection.
 * Run once right after `profileSaveAndConnect` for that runtime connection.
 */
const SQLITE_TEMPLATE_DEMO_SQL: string[] = [
  `PRAGMA foreign_keys = ON`,
  `CREATE TABLE IF NOT EXISTS demo_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS demo_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    FOREIGN KEY (user_id) REFERENCES demo_users(id)
  )`,
  `INSERT INTO demo_users (name, role) VALUES
    ('Alice', 'admin'),
    ('Bob', 'member'),
    ('Carol', 'member')`,
  `INSERT INTO demo_posts (user_id, title, body, published_at) VALUES
    (1, 'Getting started', 'Welcome to the Politedb demo database.', datetime('now')),
    (2, 'My first query', 'Try: SELECT * FROM demo_users;', datetime('now')),
    (1, 'Tips', 'Browse tables in the schema panel.', datetime('now'))`,
];

export async function seedSqliteTemplateDemo(
  connectionId: string
): Promise<void> {
  for (const sql of SQLITE_TEMPLATE_DEMO_SQL) {
    const trimmed = sql.trim();
    if (!trimmed) continue;
    await runSqlQuery(connectionId, trimmed, {
      maxRows: 10,
      timeoutMs: 30_000,
    });
  }
}
