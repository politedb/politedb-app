import { describe, expect, it } from "vitest";
import { classifyErrorMessage, sanitizeProps } from "./analytics";

describe("classifyErrorMessage", () => {
  it.each([
    ['password authentication failed for user "app"', "auth_failed"],
    [
      "Access denied for user 'root'@'10.0.0.5' (using password: YES)",
      "auth_failed",
    ],
    [
      "permission denied for table private_customer_orders",
      "permission_denied",
    ],
    [
      "could not connect to server: Connection refused at db.internal:5432",
      "connection_refused",
    ],
    [
      'could not translate host name "db.internal" to address',
      "host_not_found",
    ],
    ["SSL connection has been closed unexpectedly", "tls"],
    ["Query timed out after 60000 ms", "timeout"],
    ['database "shop" does not exist', "database_not_found"],
    ["no such table: private_customer_orders", "object_not_found"],
    ['syntax error at or near "FROM"', "syntax_error"],
    [
      'duplicate key value violates unique constraint "users_email_key"',
      "constraint_violation",
    ],
    ["Query was cancelled", "cancelled"],
    [
      "Failing row contains (alice@example.invalid, confidential_value).",
      "other",
    ],
    ["", "other"],
  ])("%s → %s", (message, kind) => {
    expect(classifyErrorMessage(message)).toBe(kind);
  });
});

describe("sanitizeProps", () => {
  it("never sends error text, only its category", () => {
    const sent = sanitizeProps({
      error:
        "Connection refused at db.internal:5432 for user alice@example.invalid",
      stream_error: "no such table: private_customer_orders",
      sql_kind: "SELECT",
      duration_ms: 12,
    });

    expect(sent).toEqual({
      error: "connection_refused",
      stream_error: "object_not_found",
      sql_kind: "SELECT",
      duration_ms: 12,
    });
    expect(JSON.stringify(sent)).not.toMatch(
      /alice|db\.internal|private_customer/
    );
  });
});
