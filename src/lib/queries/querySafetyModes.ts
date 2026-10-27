import type { QuerySafetyMode } from "./querySafety";

/** How each query safety mode is named and colored wherever it is shown. */
export type QuerySafetyModeInfo = {
  value: QuerySafetyMode;
  /** "Production mode" */
  label: string;
  /** "Production", for tight spots such as the status bar. */
  shortLabel: string;
  description: string;
  /** Dot or stripe color. */
  dotClass: string;
  /** Badge colors, light and dark. */
  badgeClass: string;
};

export const QUERY_SAFETY_MODES: QuerySafetyModeInfo[] = [
  {
    value: "default",
    label: "Default mode",
    shortLabel: "Default",
    description: "Warn before sending queries",
    dotClass: "bg-gray-500",
    badgeClass:
      "border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-transparent dark:text-slate-300",
  },
  {
    value: "lock",
    label: "Lock mode",
    shortLabel: "Lock",
    description: "Block all editing queries",
    dotClass: "bg-red-500",
    badgeClass:
      "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300",
  },
  {
    value: "safe",
    label: "Safe mode",
    shortLabel: "Safe",
    description: "Require Touch ID before sending queries",
    dotClass: "bg-green-500",
    badgeClass:
      "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300",
  },
  {
    value: "production",
    label: "Production mode",
    shortLabel: "Production",
    description: "Touch ID for reads, block writes",
    dotClass: "bg-amber-500",
    badgeClass:
      "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  },
];

export function querySafetyModeInfo(
  mode: QuerySafetyMode
): QuerySafetyModeInfo {
  return (
    QUERY_SAFETY_MODES.find((info) => info.value === mode) ??
    QUERY_SAFETY_MODES[0]!
  );
}

/**
 * Asks the active connection's menu bar to open its safety mode picker, so
 * the mode is changed in one place whatever opened the picker.
 */
export const OPEN_SAFETY_MODE_PICKER_EVENT = "politedb-open-safety-mode-picker";

export function requestOpenSafetyModePicker() {
  window.dispatchEvent(new Event(OPEN_SAFETY_MODE_PICKER_EVENT));
}
