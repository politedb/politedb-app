import { Checkbox } from "src/components/common/Checkbox";
import { Input } from "src/components/common/Input";
import { FieldRow } from "src/components/settings/FieldRow";
import { SettingCard } from "src/components/settings/SettingCard";
import type {
  AppSettings,
  SettingsUpdate,
} from "src/components/settings/types";

export function GeneralSettings(props: {
  settings: AppSettings;
  update: SettingsUpdate;
}) {
  const { settings, update } = props;

  return (
    <>
      <SettingCard title="Query defaults">
        <FieldRow
          label="Default row limit"
          description="Used for initial table browsing and generated SQL suggestions."
        >
          <Input
            type="number"
            value={settings.defaultRowLimit}
            onValueChange={(value) => update("defaultRowLimit", value)}
          />
        </FieldRow>
        <FieldRow
          label="Query timeout"
          description="Default timeout in seconds for long-running operations."
        >
          <Input
            type="number"
            value={settings.queryTimeoutSeconds}
            onValueChange={(value) => update("queryTimeoutSeconds", value)}
          />
        </FieldRow>
      </SettingCard>
      <SettingCard title="Editor">
        <Checkbox
          checked={settings.autosaveSqlDrafts}
          onChange={(event) =>
            update("autosaveSqlDrafts", event.currentTarget.checked)
          }
          label="Autosave SQL editor drafts"
          description="Keep editor text available when a connection or window reopens."
        />
      </SettingCard>
    </>
  );
}
