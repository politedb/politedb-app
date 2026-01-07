import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const win = getCurrentWebviewWindow();

export function WindowControls() {
  async function onClose() {
    await win.close();
  }

  async function onMinimize() {
    await win.minimize();
  }

  async function onToggleMaximize() {
    const isMax = await win.isMaximized();
    if (isMax) await win.unmaximize();
    else await win.maximize();
  }

  return (
    <div class="window-controls flex items-center gap-2">
      <button
        type="button"
        class="h-3 w-3 rounded-full bg-red-500 hover:opacity-80"
        onClick={onClose}
        aria-label="Close"
        title="Close"
      />
      <button
        type="button"
        class="h-3 w-3 rounded-full bg-yellow-500 hover:opacity-80"
        onClick={onMinimize}
        aria-label="Minimize"
        title="Minimize"
      />
      <button
        type="button"
        class="h-3 w-3 rounded-full bg-green-500 hover:opacity-80"
        onClick={onToggleMaximize}
        aria-label="Maximize"
        title="Maximize"
      />
    </div>
  );
}
