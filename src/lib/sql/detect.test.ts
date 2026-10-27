import { describe, expect, it } from "vitest";
import { isDDLStatement, isMutatingStatement } from "./detect";

describe("isMutatingStatement", () => {
  it.each([
    // Writable CTE (PostgreSQL).
    "WITH gone AS (DELETE FROM a RETURNING *) SELECT * FROM gone;",
    // Nested block comments (PostgreSQL) hiding a write.
    "/* outer /* inner */ still outer */ DELETE FROM a;",
    // Executable comments (MySQL/MariaDB) run their content.
    "/*!50000 DROP TABLE a */;",
    "/*M!100100 DROP TABLE a */;",
    // Server-wide or persisted settings.
    "SET GLOBAL read_only = OFF;",
    "SET PERSIST max_connections = 10;",
    "SET @@global.read_only = 0;",
    // Permissions, bulk loads, maintenance.
    "GRANT ALL ON a TO bob;",
    "REVOKE SELECT ON a FROM bob;",
    "COPY a FROM '/tmp/a.csv';",
    "LOAD DATA INFILE 'a.csv' INTO TABLE a;",
    "REFRESH MATERIALIZED VIEW v;",
    "VACUUM a;",
    // SELECT … INTO creates a table or writes a file.
    "SELECT * INTO backup_a FROM a;",
    "SELECT * FROM a INTO OUTFILE '/tmp/a';",
    // A final SELECT … INTO after a WITH list.
    "WITH t AS (SELECT 1 AS id) SELECT * INTO backup_a FROM t;",
    // Comments between the tokens of a server-wide setting.
    "SET /* comment */ GLOBAL read_only = OFF;",
    "SET @@global /* comment */ .read_only = OFF;",
    "SET SESSION sql_mode = '', GLOBAL read_only = OFF;",
    // A backslash-escaped quote (MySQL) does not end the string early.
    "SELECT 'a\\'' INTO OUTFILE '/tmp/x';",
  ])("treats %s as a write", (sql) => {
    expect(isMutatingStatement(sql)).toBe(true);
  });

  it.each([
    "INSERT INTO a VALUES (1);",
    "-- note\nUPDATE a SET x = 1;",
    "/* note */ DELETE FROM a;",
    "CREATE TABLE a (id int);",
    "BEGIN;",
    "COMMIT;",
    "DO $$ BEGIN PERFORM 1; END $$;",
  ])("keeps %s a write", (sql) => {
    expect(isMutatingStatement(sql)).toBe(true);
  });

  it.each([
    "SELECT 1;",
    "-- note\nSELECT * FROM a;",
    "/* outer /* inner */ */ SELECT 1;",
    "/* plain comment */ SELECT 1;",
    "SELECT * FROM a WHERE note = 'put into box';",
    "WITH t AS (SELECT 1) SELECT * FROM t;",
    "WITH t AS (SELECT 'delete me' AS x) SELECT * FROM t;",
    "SET search_path TO public;",
    "SET SESSION sql_mode = '';",
    "SET search_path TO global_schema;",
    // Keywords inside dollar quotes and comments are not code.
    "SELECT $$into$$;",
    "SELECT $tag$ DELETE FROM a $tag$;",
    "SELECT 1 /* INTO */;",
    "SELECT 1 -- INTO\n;",
    "WITH t AS (SELECT 1 /* DELETE */) SELECT * FROM t;",
    'SELECT "into" FROM a;',
    "SELECT $1::int;",
    "SHOW TABLES;",
    "EXPLAIN SELECT 1;",
    "",
  ])("treats %s as a read", (sql) => {
    expect(isMutatingStatement(sql)).toBe(false);
  });
});

describe("isDDLStatement", () => {
  it("still recognises DDL after comments", () => {
    expect(isDDLStatement("-- x\nCREATE TABLE a (id int)")).toBe(true);
    expect(isDDLStatement("SELECT 1")).toBe(false);
  });
});
