export const UI_DENSITY_PREFERENCES = ["comfortable", "compact"] as const;

export type UiDensityPreference = (typeof UI_DENSITY_PREFERENCES)[number];

const SETTINGS_STORAGE_KEY = "politedb:app-settings:v1";

export function isUiDensityPreference(
  value: unknown
): value is UiDensityPreference {
  return UI_DENSITY_PREFERENCES.includes(value as UiDensityPreference);
}

export function getStoredUiDensityPreference(): UiDensityPreference {
  if (typeof window === "undefined") return "comfortable";
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return "comfortable";
    const parsed = JSON.parse(raw) as { density?: unknown };
    return isUiDensityPreference(parsed.density)
      ? parsed.density
      : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function getAppliedUiDensity(): UiDensityPreference {
  if (typeof document === "undefined") return "comfortable";
  const density = document.documentElement.dataset.density;
  return isUiDensityPreference(density) ? density : "comfortable";
}

export function applyUiDensityPreference(density: UiDensityPreference) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.density = density;
  window.dispatchEvent(
    new CustomEvent("politedb:densitychange", { detail: { density } })
  );
}

export function applyStoredUiDensityPreference() {
  applyUiDensityPreference(getStoredUiDensityPreference());
}
