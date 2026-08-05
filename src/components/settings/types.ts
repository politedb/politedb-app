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
  density: "comfortable" | "compact";
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
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveAppSettings(settings: AppSettings) {
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
