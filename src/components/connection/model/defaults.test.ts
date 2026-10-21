import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "src/lib/tauri";
import type { DatabaseEngine } from "src/types";
import { makeDefaultValues } from "./defaults";

describe("makeDefaultValues credentials", () => {
  it.each<DatabaseEngine>([
    "postgres",
    "mysql",
    "mariadb",
    "sqlserver",
    "oracle",
    "clickhouse",
    "snowflake",
    "redis",
    "mongo",
  ])("leaves Database and User empty for a new %s connection", (engine) => {
    const values = makeDefaultValues(undefined, engine);

    expect(values.user).toBe("");
    expect(values.database).toBe("");
  });

  it("keeps the saved Database and User of an existing connection", () => {
    const profile = {
      id: "p1",
      label: "Prod",
      engine: "postgres",
      input: {
        engine: "postgres",
        label: "Prod",
        tags: [],
        postgres: { host: "db", port: 5432, user: "app", database: "shop" },
      },
    } as unknown as ConnectionProfile;

    const values = makeDefaultValues(profile);

    expect(values.user).toBe("app");
    expect(values.database).toBe("shop");
  });
});
