import { useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { SettingCard } from "src/components/settings/SettingCard";
import type { AppSettings } from "src/components/settings/types";
import { useAppUpdater } from "src/hooks/useAppUpdater";

export function DiagnosticsSettings(props: {
  settings: AppSettings;
  onResetSettings: () => void;
}) {
  const [copiedDebugInfo, setCopiedDebugInfo] = useState(false);
  const { appVersion } = useAppUpdater();

  async function copyDebugInfo() {
    const info = {
      appVersion,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screen: `${window.screen.width}x${window.screen.height}`,
      devicePixelRatio: window.devicePixelRatio,
      settings: {
        theme: props.settings.theme,
        uiFont: props.settings.uiFont,
        density: props.settings.density,
        defaultRowLimit: props.settings.defaultRowLimit,
        queryTimeoutSeconds: props.settings.queryTimeoutSeconds,
      },
    };
    await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
    setCopiedDebugInfo(true);
    window.setTimeout(() => setCopiedDebugInfo(false), 1500);
  }

  return (
    <SettingCard title="Diagnostics">
      <Button variant="outline" onClick={() => void copyDebugInfo()}>
        {copiedDebugInfo ? "Copied" : "Copy debug info"}
      </Button>
      <Button variant="outline" onClick={props.onResetSettings}>
        Reset local settings
      </Button>
    </SettingCard>
  );
}
