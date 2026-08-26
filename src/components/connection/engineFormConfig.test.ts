import { describe, expect, it } from "vitest";
import { SUPPORTED_DATABASES } from "src/constant";
import type { FormValues } from "./types";
import {
  CONNECTION_FORM_ENGINE_CONFIG,
  getConnectionFormEngineConfig,
  getCredentialInputPlaceholder,
  hasRequiredConnectionFields,
} from "./engineFormConfig";

function formValues(patch: Partial<FormValues>): FormValues {
  return {
    engine: "postgres",
    host: "localhost",
    port: 5432,
    user: "postgres",
    database: "postgres",
    password: "secret",
    storeKeychain: false,
    snowflakeWarehouse: "",
    ...patch,
  } as FormValues;
}

describe("connection form engine config", () => {
  it("defines presentation and capability config for every supported engine", () => {
    for (const database of SUPPORTED_DATABASES) {
      expect(CONNECTION_FORM_ENGINE_CONFIG[database.engine]).toBeDefined();
    }
  });

  it("disables irrelevant network sections for Google Sheets", () => {
    const config = getConnectionFormEngineConfig("google_sheets");

    expect(config.showHostPort).toBe(false);
    expect(config.showSsl).toBe(false);
    expect(config.showSsh).toBe(false);
    expect(config.requiredHint).toContain("Spreadsheet ID or URL");
  });

  it("uses engine-specific credential placeholders", () => {
    const sheets = getConnectionFormEngineConfig("google_sheets");
    const postgres = getConnectionFormEngineConfig("postgres");

    expect(getCredentialInputPlaceholder(sheets, true)).toBe(
      "Google API key or OAuth access token (ya29...)"
    );
    expect(getCredentialInputPlaceholder(postgres, true)).toBe(
      "Enter password (save in Keychain)"
    );
  });

  it("checks required fields by engine", () => {
    expect(
      hasRequiredConnectionFields(
        formValues({
          engine: "google_sheets",
          host: "",
          port: 0,
          user: "",
          database: "sheet-id",
        })
      )
    ).toBe(true);

    expect(
      hasRequiredConnectionFields(
        formValues({ engine: "postgres", user: "", password: "" })
      )
    ).toBe(false);

    expect(
      hasRequiredConnectionFields(
        formValues({
          engine: "redis",
          user: "",
          password: "",
          database: "",
        })
      )
    ).toBe(true);
  });
});
