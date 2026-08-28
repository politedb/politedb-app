import { Select } from "src/components/common/Select";
import { FieldRow } from "src/components/settings/FieldRow";
import { SettingCard } from "src/components/settings/SettingCard";
import type {
  AppSettings,
  SettingsUpdate,
} from "src/components/settings/types";

export function AppearanceSettings(props: {
  settings: AppSettings;
  update: SettingsUpdate;
}) {
  const { settings, update } = props;

  return (
    <SettingCard class="[&>div>div]:last:pb-4">
      <FieldRow label="Theme" description="Switch theme mode.">
        <Select
          value={settings.theme}
          onChange={(event) =>
            update("theme", event.currentTarget.value as AppSettings["theme"])
          }
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </Select>
      </FieldRow>
      <FieldRow
        label="Density"
        description="Compact mode keeps tables and sidebars tighter."
      >
        <Select
          value={settings.density}
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
