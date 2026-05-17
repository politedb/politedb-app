import type { DatabaseEngine } from "src/types";

export type SqlTransactionControl = {
  begin: string | null;
  commit: string;
  rollback: string;
};

export function sqlTransactionControl(
  engine: DatabaseEngine
): SqlTransactionControl {
  if (engine === "sqlserver") {
    return {
      begin: "BEGIN TRANSACTION;",
      commit: "COMMIT TRANSACTION;",
      rollback: "ROLLBACK TRANSACTION;",
    };
  }

  if (engine === "oracle") {
    return {
      begin: null,
      commit: "COMMIT;",
      rollback: "ROLLBACK;",
    };
  }

  return {
    begin: "BEGIN;",
    commit: "COMMIT;",
    rollback: "ROLLBACK;",
  };
}

export async function runSqlTransaction(args: {
  engine: DatabaseEngine;
  statements: string[];
  run: (sql: string) => Promise<void>;
}) {
  const { engine, statements, run } = args;
  const tx = sqlTransactionControl(engine);

  if (tx.begin) {
    await run(tx.begin);
  }

  try {
    for (const statement of statements) {
      await run(statement);
    }
    await run(tx.commit);
  } catch (error) {
    try {
      await run(tx.rollback);
    } catch {}
    throw error;
  }
}
