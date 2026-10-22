import { Select } from "src/components/common/Select";
import { FieldRow } from "src/components/settings/FieldRow";
import { SettingCard } from "src/components/settings/SettingCard";
import type {
  AppSettings,
  SettingsUpdate,
} from "src/components/settings/types";
import {
  getUiFontStack,
  UI_FONT_OPTIONS,
  type UiFontPreference,
} from "src/lib/uiFont";
import { cn } from "src/utils/cn";

type Theme = AppSettings["theme"];

/**
 * Preview colors for the theme tiles. Inline styles, not theme classes: the
 * dark theme remaps light utility colors, and a Light tile must stay light.
 */
const TILE = {
  light: { surface: "#ffffff", bar: "#e2e8f0", line: "#cbd5e1" },
  dark: { surface: "#1f1f1f", bar: "#353535", line: "#4a4a4a" },
} as const;

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function ThemeTile(props: { variant: "light" | "dark" }) {
  const c = TILE[props.variant];
  return (
    <div
      class="flex h-full w-full flex-col gap-1 p-1.5"
      style={{ background: c.surface }}
    >
      <div class="h-1.5 w-full rounded-sm" style={{ background: c.bar }} />
      <div class="h-1 w-3/4 rounded-sm" style={{ background: c.line }} />
      <div class="h-1 w-1/2 rounded-sm" style={{ background: c.line }} />
    </div>
  );
}

function ThemePicker(props: {
  value: Theme;
  onChange: (theme: Theme) => void;
}) {
  const { value, onChange } = props;
  return (
    // Native radios: arrow keys move between themes as expected.
    <div role="radiogroup" aria-label="Theme" class="flex gap-2">
      {THEMES.map((theme) => {
        const checked = value === theme.value;
        return (
          <label
            key={theme.value}
            class="group flex cursor-pointer flex-col items-center gap-1"
          >
            <input
              type="radio"
              name="settings-theme"
              value={theme.value}
              checked={checked}
              class="peer sr-only"
              onChange={() => onChange(theme.value)}
            />
            <span
              class={cn(
                "flex h-11 w-16 overflow-hidden rounded-lg border",
                "peer-focus-visible:ring-2 peer-focus-visible:ring-blue-300",
                checked
                  ? "border-blue-500 ring-2 ring-blue-500/30"
                  : "border-slate-300 group-hover:border-slate-400"
              )}
            >
              {theme.value === "system" ? (
                <>
                  <span class="w-1/2 overflow-hidden">
                    <ThemeTile variant="light" />
                  </span>
                  <span class="w-1/2 overflow-hidden">
                    <ThemeTile variant="dark" />
                  </span>
                </>
              ) : (
                <ThemeTile variant={theme.value} />
              )}
            </span>
            <span
              class={cn(
                "text-xs",
                checked ? "font-semibold text-slate-900" : "text-slate-600"
              )}
            >
              {theme.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function AppearanceSettings(props: {
  settings: AppSettings;
  update: SettingsUpdate;
}) {
  const { settings, update } = props;
  const [defaultFont, ...otherFonts] = UI_FONT_OPTIONS;

  return (
    <SettingCard class="[&>div>div]:last:pb-4">
      <FieldRow
        label="Theme"
        description="Follow your system, or always use light or dark."
      >
        <ThemePicker
          value={settings.theme}
          onChange={(theme) => update("theme", theme)}
        />
      </FieldRow>
      <FieldRow
        label="Application font"
        description="Font used across the app. The SQL editor keeps its own font."
      >
        <Select
          value={settings.uiFont}
          aria-label="Application font"
          onChange={(event) =>
            update("uiFont", event.currentTarget.value as UiFontPreference)
          }
        >
          <optgroup label="Default">
            <option value={defaultFont!.value}>{defaultFont!.label}</option>
          </optgroup>
          <optgroup label="Other fonts">
            {otherFonts.map((font) => (
              <option
                key={font.value}
                value={font.value}
                // Shown in its own face where the platform allows it.
                style={{ fontFamily: getUiFontStack(font.value) }}
              >
                {font.label}
              </option>
            ))}
          </optgroup>
        </Select>
      </FieldRow>
      <FieldRow
        label="Density"
        description="Compact mode keeps tables and sidebars tighter."
      >
        <Select
          value={settings.density}
          aria-label="Density"
          onChange={(event) =>
            update(
              "density",
              event.currentTarget.value as AppSettings["density"]
            )
          }
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </Select>
      </FieldRow>
    </SettingCard>
  );
}
