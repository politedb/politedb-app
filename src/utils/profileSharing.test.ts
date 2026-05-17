import { describe, expect, it } from "vitest";
import {
  isEncryptedExportFile,
  isSharingExport,
  parseProfileExportMeta,
} from "./profileSharing";

describe("profileSharing", () => {
  it("detects sharing export metadata", () => {
    const meta = parseProfileExportMeta(
      JSON.stringify({
        version: 1,
        export_mode: "sharing",
        secrets_redacted: false,
        included_db_password: true,
        profiles: [],
      })
    );
    expect(isSharingExport(meta)).toBe(true);
    expect(meta?.included_db_password).toBe(true);
  });

  it("detects encrypted export wrapper", () => {
    expect(
      isEncryptedExportFile(
        JSON.stringify({ format: "politedb_encrypted_export_v1" })
      )
    ).toBe(true);
  });

  it("treats legacy exports as non-sharing", () => {
    const meta = parseProfileExportMeta(
      JSON.stringify({ version: 1, profiles: [] })
    );
    expect(isSharingExport(meta)).toBe(false);
  });
});
