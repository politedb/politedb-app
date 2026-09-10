export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const SETTINGS_STORAGE_KEY = "politedb:app-settings:v1";
const THEME_TRANSITION_CLASS = "theme-transition";
const THEME_TRANSITION_DURATION_MS = 180;

let themeTransitionTimer: ReturnType<typeof setTimeout> | undefined;

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveThemePreference(
  preference: ThemePreference
): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function getStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return "system";
    const parsed = JSON.parse(raw) as { theme?: unknown };
    return parsed.theme === "light" || parsed.theme === "dark"
      ? parsed.theme
      : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(
  preference: ThemePreference,
  options: { animate?: boolean } = {}
) {
  if (typeof document === "undefined") return;
  const resolved = resolveThemePreference(preference);
  const root = document.documentElement;
  const shouldAnimate = options.animate && getResolvedTheme() !== resolved;

  if (themeTransitionTimer) clearTimeout(themeTransitionTimer);
  root.classList.toggle(THEME_TRANSITION_CLASS, Boolean(shouldAnimate));
  if (shouldAnimate) {
    themeTransitionTimer = setTimeout(() => {
      root.classList.remove(THEME_TRANSITION_CLASS);
      themeTransitionTimer = undefined;
    }, THEME_TRANSITION_DURATION_MS);
  }

  root.dataset.themePreference = preference;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", resolved === "dark");
  window.dispatchEvent(
    new CustomEvent("politedb:themechange", {
      detail: { preference, resolved },
    })
  );
}

export function applyStoredThemePreference() {
  applyThemePreference(getStoredThemePreference());
}

export function installSystemThemeListener() {
  if (typeof window === "undefined") return () => {};
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getStoredThemePreference() === "system") {
      applyThemePreference("system", { animate: true });
    }
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function getResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ||
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}
