export const UI_FONT_PREFERENCES = [
  "system",
  "inter",
  "sans-serif",
  "serif",
  "monospace",
  "arial",
  "helvetica",
  "verdana",
  "tahoma",
  "trebuchet",
  "georgia",
  "times",
  "courier",
] as const;

export type UiFontPreference = (typeof UI_FONT_PREFERENCES)[number];

const SETTINGS_STORAGE_KEY = "politedb:app-settings:v1";

const UI_FONT_STACKS: Record<UiFontPreference, string> = {
  inter: '"Inter", sans-serif',
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "sans-serif":
    'Arial, "Helvetica Neue", Helvetica, "Liberation Sans", "Nimbus Sans", sans-serif',
  serif:
    'Georgia, "Times New Roman", "Liberation Serif", "Nimbus Roman", serif',
  monospace:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Nimbus Mono PS", monospace',
  arial: 'Arial, "Liberation Sans", sans-serif',
  helvetica:
    '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif',
  verdana: 'Verdana, Geneva, "DejaVu Sans", sans-serif',
  tahoma: 'Tahoma, Geneva, Verdana, "DejaVu Sans", sans-serif',
  trebuchet: '"Trebuchet MS", "Lucida Grande", "DejaVu Sans", sans-serif',
  georgia:
    'Georgia, "Times New Roman", "Liberation Serif", "Nimbus Roman", serif',
  times: '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif',
  courier:
    '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", monospace',
};

export const UI_FONT_OPTIONS: Array<{
  value: UiFontPreference;
  label: string;
}> = [
  { value: "system", label: "System default" },
  { value: "inter", label: "Inter" },
  { value: "sans-serif", label: "Sans serif" },
  { value: "serif", label: "Serif" },
  { value: "monospace", label: "Monospace" },
  { value: "arial", label: "Arial" },
  { value: "helvetica", label: "Helvetica" },
  { value: "verdana", label: "Verdana" },
  { value: "tahoma", label: "Tahoma" },
  { value: "trebuchet", label: "Trebuchet MS" },
  { value: "georgia", label: "Georgia" },
  { value: "times", label: "Times New Roman" },
  { value: "courier", label: "Courier New" },
];

export function isUiFontPreference(value: unknown): value is UiFontPreference {
  return UI_FONT_PREFERENCES.includes(value as UiFontPreference);
}

export function getUiFontStack(preference: UiFontPreference): string {
  return UI_FONT_STACKS[preference];
}

export function getStoredUiFontPreference(): UiFontPreference {
  if (typeof window === "undefined") return "inter";
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return "inter";
    const parsed = JSON.parse(raw) as { uiFont?: unknown };
    return isUiFontPreference(parsed.uiFont) ? parsed.uiFont : "inter";
  } catch {
    return "inter";
  }
}

export function applyUiFontPreference(preference: UiFontPreference) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const stack = getUiFontStack(preference);
  root.dataset.uiFont = preference;
  root.style.setProperty("--font-ui", stack);
  window.dispatchEvent(
    new CustomEvent("politedb:fontchange", {
      detail: { preference, stack },
    })
  );
}

export function applyStoredUiFontPreference() {
  applyUiFontPreference(getStoredUiFontPreference());
}

export function getAppliedUiFontStack(): string {
  if (typeof document === "undefined") return UI_FONT_STACKS.inter;
  const preference = document.documentElement.dataset.uiFont;
  return isUiFontPreference(preference)
    ? getUiFontStack(preference)
    : UI_FONT_STACKS.inter;
}
