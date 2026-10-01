export const ENCRYPTED_EXPORT_FORMAT = "politedb_encrypted_export_v1";
export const CONNECTION_EXPORT_EXTENSION = "politedbconnection";

export type ProfileExportFileMeta = {
  version?: number;
  exported_at?: number;
  export_mode?: string | null;
  secrets_redacted?: boolean;
  sharing_checklist?: string[];
  included_db_password?: boolean;
  included_ssh_password?: boolean;
  profiles?: unknown[];
};

export type SharingSecretFlags = {
  includeDbPassword?: boolean;
  includeSshPassword?: boolean;
};

export function isEncryptedExportFile(json: string) {
  try {
    const parsed = JSON.parse(json) as { format?: string };
    return parsed?.format === ENCRYPTED_EXPORT_FORMAT;
  } catch {
    return false;
  }
}

export function parseProfileExportMeta(
  json: string
): ProfileExportFileMeta | null {
  try {
    const parsed = JSON.parse(json) as ProfileExportFileMeta;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isSharingExport(meta: ProfileExportFileMeta | null) {
  return !!meta?.secrets_redacted || meta?.export_mode === "sharing";
}

export function formatSharingExportSuccessMessage(
  flags: SharingSecretFlags = {}
) {
  const lines = [
    "Connection exported for sharing. The file is encrypted.",
    "",
    "Send the recipient:",
    `• This encrypted .${CONNECTION_EXPORT_EXTENSION} file`,
    "• The export file password (separate secure channel)",
  ];

  if (!flags.includeDbPassword) {
    lines.push("• Database password (if not included below)");
  }
  if (!flags.includeSshPassword) {
    lines.push("• SSH password or private key file (if applicable)");
  }

  lines.push("", "Included in the encrypted file:");
  lines.push(
    flags.includeDbPassword
      ? "• Database password"
      : "• Database password — not included"
  );
  lines.push(
    flags.includeSshPassword
      ? "• SSH password (password auth only)"
      : "• SSH password — not included"
  );
  lines.push("• Connection settings (host, port, SSH tunnel, tags, …)");
  lines.push("", "SSH private key files are never included in exports.");

  return lines.join("\n");
}

export function formatExportPasswordError(err: unknown) {
  const msg = String(err ?? "");
  if (msg.includes("EXPORT_PASSWORD_REQUIRED")) {
    return "Export file password is required.";
  }
  if (msg.includes("EXPORT_DECRYPT_WRONG_PASSWORD")) {
    return "Incorrect export file password.";
  }
  if (
    msg.includes("EXPORT_DB_PASSWORD_UNAVAILABLE") ||
    msg.includes("EXPORT_PASSWORD_UNAVAILABLE")
  ) {
    return "Could not read the saved password from this device's keychain. Save the connection again or export without including passwords.";
  }
  return msg;
}

export function formatSharingImportSuccessMessage(
  result: { created: number; updated: number },
  meta?: ProfileExportFileMeta | null
) {
  const includedDb = !!meta?.included_db_password;
  const includedSsh = !!meta?.included_ssh_password;
  const needsCredentials = !includedDb || !includedSsh;

  const lines = [
    `Imported ${result.created + result.updated} connection(s).`,
    `Created: ${result.created}`,
    `Updated: ${result.updated}`,
    "",
    "This file was exported for sharing.",
    includedDb
      ? "• Database password was restored from the export."
      : "• Enter the database password in Edit connection before connecting.",
    includedSsh
      ? "• SSH password was restored when applicable."
      : "• Enter the SSH password if this connection uses password auth.",
    "• SSH private key files are never imported — select the key file on this device.",
  ];

  if (needsCredentials) {
    lines.push(
      "",
      "Open each imported connection and complete any missing credentials."
    );
  }

  if (meta?.sharing_checklist?.length) {
    lines.push("", ...meta.sharing_checklist.map((item) => `• ${item}`));
  }

  return lines.join("\n");
}
