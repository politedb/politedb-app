import { isUiFontPreference, type UiFontPreference } from "src/lib/uiFont";
import {
  isUiDensityPreference,
  type UiDensityPreference,
} from "src/lib/density";

export type SettingsDialogSection =
  | "general"
  | "appearance"
  | "analytics"
  | "license"
  | "keyboard"
  | "connections"
  | "diagnostics";

export type AppSettings = {
  theme: "system" | "light" | "dark";
  uiFont: UiFontPreference;
  density: UiDensityPreference;
  defaultRowLimit: string;
  queryTimeoutSeconds: string;
  autosaveSqlDrafts: boolean;
  autoConnectLastProfile: boolean;
  healthCheckInterval: "off" | "30" | "60" | "300";
};

export type SettingsUpdate = <K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
) => void;

export const SETTINGS_STORAGE_KEY = "politedb:app-settings:v1";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  uiFont: "inter",
  density: "comfortable",
  defaultRowLimit: "100",
  queryTimeoutSeconds: "60",
  autosaveSqlDrafts: true,
  autoConnectLastProfile: false,
  healthCheckInterval: "60",
};

export function loadAppSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      uiFont: isUiFontPreference(parsed.uiFont) ? parsed.uiFont : "inter",
      density: isUiDensityPreference(parsed.density)
        ? parsed.density
        : "comfortable",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveAppSettings(settings: AppSettings) {
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
