import { Checkbox } from "src/components/common/Checkbox";
import { Select } from "src/components/common/Select";
import { FieldRow } from "src/components/settings/FieldRow";
import { SettingCard } from "src/components/settings/SettingCard";
import type {
  AppSettings,
  SettingsUpdate,
} from "src/components/settings/types";

export function ConnectionsSettings(props: {
  settings: AppSettings;
  update: SettingsUpdate;
}) {
  const { settings, update } = props;

  return (
    <SettingCard title="Connection behavior">
      <Checkbox
        checked={settings.autoConnectLastProfile}
        onChange={(event) =>
          update("autoConnectLastProfile", event.currentTarget.checked)
        }
        label="Open last connection on launch"
        description="Restore the most recent database workspace after app restart."
      />
      <FieldRow
        label="Health check interval"
        description="How often active connections should be checked."
      >
        <Select
          value={settings.healthCheckInterval}
          onChange={(event) =>
            update(
              "healthCheckInterval",
              event.currentTarget.value as AppSettings["healthCheckInterval"]
            )
          }
        >
          <option value="off">Off</option>
          <option value="30">30 seconds</option>
          <option value="60">1 minute</option>
          <option value="300">5 minutes</option>
        </Select>
      </FieldRow>
    </SettingCard>
  );
}
