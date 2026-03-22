/**
 * Native OS dialogs (Tauri). Use this instead of importing @tauri-apps/plugin-dialog
 * directly so behavior is consistent and browser/dev without Tauri degrades safely.
 */
import {
  ask as tauriAsk,
  confirm as tauriConfirm,
  message as tauriMessage,
  open as tauriOpen,
  save as tauriSave,
  type ConfirmDialogOptions,
  type DialogFilter,
  type MessageDialogOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";

export type {
  ConfirmDialogOptions,
  DialogFilter,
  MessageDialogOptions,
  OpenDialogOptions,
  SaveDialogOptions,
};

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
  );
}

/** Open file / directory picker (native). Returns `null` if cancelled or not in Tauri. */
export async function openDialog<T extends OpenDialogOptions>(
  options?: T
): Promise<
  T["directory"] extends true
    ? T["multiple"] extends true
      ? string[] | null
      : string | null
    : T["multiple"] extends true
      ? string[] | null
      : string | null
> {
  if (!isTauriRuntime()) return null as any;
  return tauriOpen(options) as any;
}

/** Save file path picker (native). Returns `null` if cancelled or not in Tauri. */
export async function saveDialog(
  options?: SaveDialogOptions
): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return tauriSave(options);
}

/** System message (Ok). No-op in browser. */
export async function showMessage(
  body: string,
  options?: string | MessageDialogOptions
): Promise<void> {
  if (!isTauriRuntime()) {
    // eslint-disable-next-line no-alert
    window.alert(typeof options === "string" ? `${options}\n\n${body}` : body);
    return;
  }
  await tauriMessage(body, options);
}

/** Yes / No question. Returns `false` if cancelled, not in Tauri, or user picks No. */
export async function askDialog(
  body: string,
  options?: string | ConfirmDialogOptions
): Promise<boolean> {
  if (!isTauriRuntime()) {
    // eslint-disable-next-line no-alert
    return window.confirm(
      typeof options === "string" ? `${options}\n\n${body}` : body
    );
  }
  return tauriAsk(body, options);
}

/** Ok / Cancel confirm. Returns `false` if cancelled, not in Tauri, or user picks Cancel. */
export async function confirmDialog(
  body: string,
  options?: string | ConfirmDialogOptions
): Promise<boolean> {
  if (!isTauriRuntime()) {
    // eslint-disable-next-line no-alert
    return window.confirm(
      typeof options === "string" ? `${options}\n\n${body}` : body
    );
  }
  return tauriConfirm(body, options);
}

/** Single file pick (convenience). */
export async function pickOpenFile(
  options?: Omit<OpenDialogOptions, "multiple" | "directory">
) {
  return openDialog({ ...options, multiple: false, directory: false });
}

/** Multiple files (convenience). */
export async function pickOpenFiles(
  options?: Omit<OpenDialogOptions, "multiple" | "directory">
) {
  return openDialog({ ...options, multiple: true, directory: false });
}

/** Single directory (convenience). */
export async function pickOpenDirectory(
  options?: Omit<OpenDialogOptions, "directory">
) {
  return openDialog({ ...options, directory: true, multiple: false });
}
