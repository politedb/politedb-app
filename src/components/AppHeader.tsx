import { getCurrentWindow } from "@tauri-apps/api/window";

type AppHeaderProps = {
  title?: string;
  showWindowControls?: boolean;
};

export function AppHeader({ title = "PoliteDB", showWindowControls = true }: AppHeaderProps) {
  async function handleClose() {
    const appWindow = getCurrentWindow();
    await appWindow.close();
  }

  async function handleMinimize() {
    const appWindow = getCurrentWindow();
    await appWindow.minimize();
  }

  async function handleMaximize() {
    const appWindow = getCurrentWindow();
    const isMaximized = await appWindow.isMaximized();
    if (isMaximized) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
  }

  return (
    <div
      data-tauri-drag-region
      class="h-10 bg-neutral-900/95 backdrop-blur-md flex items-center justify-between px-4 shrink-0 select-none border-b border-neutral-800 rounded-t-lg"
    >
      {/* Left side - macOS window controls */}
      {showWindowControls && (
        <div class="flex items-center gap-2" data-tauri-drag-region>
          <button
            type="button"
            class="w-3 h-3 rounded-full bg-[#ff5f57] hover:bg-[#ff3b30] transition-colors cursor-pointer flex items-center justify-center group"
            title="Close"
            onClick={handleClose}
          >
            <span class="w-1 h-1 rounded-full bg-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity"></span>
          </button>
          <button
            type="button"
            class="w-3 h-3 rounded-full bg-[#ffbd2e] hover:bg-[#ff9500] transition-colors cursor-pointer flex items-center justify-center group"
            title="Minimize"
            onClick={handleMinimize}
          >
            <span class="w-1 h-1 rounded-full bg-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity"></span>
          </button>
          <button
            type="button"
            class="w-3 h-3 rounded-full bg-[#28c840] hover:bg-[#20d046] transition-colors cursor-pointer flex items-center justify-center group"
            title="Maximize"
            onClick={handleMaximize}
          >
            <span class="w-1 h-1 rounded-full bg-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity"></span>
          </button>
        </div>
      )}

      {/* Center - App branding (only if window controls are shown) */}
      {showWindowControls ? (
        <div class="flex-1 flex items-center justify-center" data-tauri-drag-region>
          <div class="flex items-center gap-2">
            <div class="w-5 h-5 rounded bg-linear-to-br from-blue-500 to-blue-600 flex items-center justify-center">
              <span class="text-white font-bold text-xs">P</span>
            </div>
            <span class="text-xs font-medium text-neutral-300">{title}</span>
          </div>
        </div>
      ) : (
        <div class="flex items-center gap-2" data-tauri-drag-region>
          <div class="w-6 h-6 rounded bg-linear-to-br from-blue-500 to-blue-600 flex items-center justify-center">
            <span class="text-white font-bold text-xs">P</span>
          </div>
          <span class="text-sm font-medium text-neutral-200">{title}</span>
        </div>
      )}

      {/* Right side - Empty space for balance when controls are on left */}
      {showWindowControls && <div class="w-20"></div>}
    </div>
  );
}
