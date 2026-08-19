import type { ExternalImportResult } from "src/lib/tauri/types";

export const IMPORT_FILE_EXTENSIONS = [
  "politedbconnection",
  "json",
  "tableplusconnection",
  "plist",
  "env",
] as const;

export function isTablePlusEncryptedPath(path: string) {
  return path.toLowerCase().endsWith(".tableplusconnection");
}

export function isLikelyDBeaverPath(path: string) {
  const lower = path.toLowerCase();
  return (
    lower.endsWith("data-sources.json") ||
    lower.includes(".dbeaver") ||
    (lower.endsWith(".json") && lower.includes("dbeaver"))
  );
}

export function isLikelyTablePlusPlistPath(path: string) {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".plist") ||
    lower.endsWith("connections.plist") ||
    lower.includes("tableplus")
  );
}

export function formatExternalImportSuccessMessage(
  result: ExternalImportResult
) {
  const sourceLabel =
    result.source === "dbeaver"
      ? "DBeaver"
      : result.source === "env"
        ? ".env"
        : "TablePlus";

  const lines = [
    `Imported ${result.created} connection(s) from ${sourceLabel}.`,
    `Skipped: ${result.skipped}`,
  ];

  if (result.skipped > 0 && result.skipped_reasons.length > 0) {
    const preview = result.skipped_reasons.slice(0, 5);
    lines.push("", "Skipped details:");
    for (const reason of preview) {
      lines.push(`• ${reason}`);
    }
    if (result.skipped_reasons.length > preview.length) {
      lines.push(
        `• …and ${result.skipped_reasons.length - preview.length} more`
      );
    }
  }

  if (result.source === "dbeaver") {
    lines.push(
      "",
      "DBeaver stores passwords in a separate encrypted credentials file. Enter database passwords in PoliteDB after import."
    );
  } else if (result.source === "tableplus" && !result.passwords_included) {
    lines.push(
      "",
      "No passwords were found in this TablePlus export. Re-enter them in each connection after import."
    );
  }

  return lines.join("\n");
}

export function formatExternalImportError(err: unknown) {
  const msg = String(err);
  if (msg.includes("TABLEPLUS_PASSWORD_REQUIRED")) {
    return "Enter the export password you used in TablePlus.";
  }
  if (msg.includes("TABLEPLUS_DECRYPT_FAILED")) {
    return "Wrong TablePlus export password, or the file is corrupted.";
  }
  if (
    msg.includes("DBEAVER_IMPORT_EMPTY") ||
    msg.includes("TABLEPLUS_IMPORT_EMPTY") ||
    msg.includes("ENV_IMPORT_EMPTY")
  ) {
    return "No supported connections were found in this file.";
  }
  return msg;
}
