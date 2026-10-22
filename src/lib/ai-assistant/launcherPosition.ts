/** Distance of the floating assistant button from the window's right and bottom edges. */
export type LauncherPosition = { right: number; bottom: number };

export const DEFAULT_LAUNCHER_POSITION: LauncherPosition = {
  right: 24,
  bottom: 36,
};

/** Gap kept between the button and the window edges. */
const EDGE = 8;
const STORAGE_KEY = "politedb.assistant-launcher-position.v1";

/** Keeps the whole button inside a window of the given size. */
export function clampLauncherPosition(
  position: LauncherPosition,
  viewport: { width: number; height: number },
  size: number
): LauncherPosition {
  const clamp = (value: number, max: number) =>
    Math.min(Math.max(value, EDGE), Math.max(EDGE, max - size - EDGE));
  return {
    right: Math.round(clamp(position.right, viewport.width)),
    bottom: Math.round(clamp(position.bottom, viewport.height)),
  };
}

/** The saved position, or the default when none is saved or storage fails. */
export function loadLauncherPosition(): LauncherPosition {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAUNCHER_POSITION;
    const parsed = JSON.parse(raw) as Partial<LauncherPosition>;
    if (
      typeof parsed.right === "number" &&
      typeof parsed.bottom === "number" &&
      Number.isFinite(parsed.right) &&
      Number.isFinite(parsed.bottom)
    ) {
      return { right: parsed.right, bottom: parsed.bottom };
    }
  } catch {
    // ignore unreadable storage
  }
  return DEFAULT_LAUNCHER_POSITION;
}

export function saveLauncherPosition(position: LauncherPosition) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
  } catch {
    // ignore storage failures; the button just returns to its default spot
  }
}
