import { useEffect, useMemo, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { AnalyticsSettings } from "src/components/settings/AnalyticsSettings";
import { AppearanceSettings } from "src/components/settings/AppearanceSettings";
import { ConnectionsSettings } from "src/components/settings/ConnectionsSettings";
import { DiagnosticsSettings } from "src/components/settings/DiagnosticsSettings";
import { GeneralSettings } from "src/components/settings/GeneralSettings";
import { KeyboardSettings } from "src/components/settings/KeyboardSettings";
import { LicenseKeySettings } from "@root/src/components/settings/LicenseKeySettings";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import {
  DEFAULT_SETTINGS,
  loadAppSettings,
  saveAppSettings,
  type AppSettings,
  type SettingsDialogSection,
} from "src/components/settings/types";
import { applyThemePreference } from "src/lib/theme";
import { applyUiFontPreference } from "src/lib/uiFont";
import { applyUiDensityPreference } from "src/lib/density";

export type { SettingsDialogSection } from "src/components/settings/types";

type Props = {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsDialogSection;
};

const SECTIONS: Array<{
  id: SettingsDialogSection;
  label: string;
  caption: string;
}> = [
  {
    id: "appearance",
    label: "Appearance",
    caption: "Theme, font and density",
  },
  {
    id: "analytics",
    label: "Privacy & Analytics",
    caption: "Telemetry controls",
  },
  { id: "license", label: "License key", caption: "Activation and plan" },
  { id: "keyboard", label: "Keyboard shortcuts", caption: "Command hotkeys" },
];

export function SettingsDialog(props: Props) {
  const { open, onClose, initialSection } = props;
  const [activeSection, setActiveSection] = useState<SettingsDialogSection>(
    initialSection ?? "appearance"
  );
  const [settings, setSettings] = useState<AppSettings>(() =>
    loadAppSettings()
  );

  useEffect(() => {
    saveAppSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (open) {
      setActiveSection(initialSection ?? "appearance");
    }
  }, [initialSection, open]);

  const activeMeta = useMemo(
    () => SECTIONS.find((section) => section.id === activeSection),
    [activeSection]
  );

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    if (key === "theme") {
      applyThemePreference(value as AppSettings["theme"], { animate: true });
    }
    if (key === "uiFont") {
      applyUiFontPreference(value as AppSettings["uiFont"]);
    }
    if (key === "density") {
      applyUiDensityPreference(value as AppSettings["density"]);
    }
  }

  function resetSettings() {
    setSettings(DEFAULT_SETTINGS);
    applyThemePreference(DEFAULT_SETTINGS.theme, { animate: true });
    applyUiFontPreference(DEFAULT_SETTINGS.uiFont);
    applyUiDensityPreference(DEFAULT_SETTINGS.density);
  }

  function renderSection() {
    switch (activeSection) {
      case "general":
        return <GeneralSettings settings={settings} update={update} />;
      case "appearance":
        return <AppearanceSettings settings={settings} update={update} />;
      case "analytics":
        return (
          <AnalyticsSettings active={open && activeSection === "analytics"} />
        );
      case "license":
        return (
          <LicenseKeySettings active={open && activeSection === "license"} />
        );
      case "keyboard":
        return (
          <KeyboardSettings active={open && activeSection === "keyboard"} />
        );
      case "connections":
        return <ConnectionsSettings settings={settings} update={update} />;
      case "diagnostics":
        return (
          <DiagnosticsSettings
            settings={settings}
            onResetSettings={resetSettings}
          />
        );
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      className="flex h-[min(580px,86vh)] max-w-4xl flex-col overflow-hidden"
    >
      <DialogHeader className="border-b border-slate-200">
        <DialogTitle className="text-lg font-semibold">Settings</DialogTitle>
      </DialogHeader>
      <DialogContent className="grid min-h-0 flex-1 grid-cols-[220px_1fr] gap-0 p-0">
        <aside class="min-h-0 overflow-hidden border-r border-slate-200 bg-slate-50">
          <OverlayScrollArea
            className="h-full"
            contentClassName="space-y-1 p-3"
          >
            {SECTIONS.map((section) => {
              const selected = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  class={[
                    "w-full rounded-lg px-3 py-2 text-left transition-colors",
                    selected
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
                  ].join(" ")}
                  onClick={() => setActiveSection(section.id)}
                >
                  <div class="text-sm font-semibold">{section.label}</div>
                  <div
                    class={[
                      "mt-0.5 truncate text-xs",
                      selected ? "text-white" : "text-slate-500",
                    ].join(" ")}
                  >
                    {section.caption}
                  </div>
                </button>
              );
            })}
          </OverlayScrollArea>
        </aside>
        <main class="min-h-0 overflow-hidden bg-white">
          <OverlayScrollArea className="h-full" contentClassName="px-5 py-3">
            <div class="mb-4">
              <h2 class="text-base font-semibold text-slate-950">
                {activeMeta?.label}
              </h2>
              <p class="mt-0.5 text-sm text-slate-500">{activeMeta?.caption}</p>
            </div>
            <div class="space-y-3">{renderSection()}</div>
          </OverlayScrollArea>
        </main>
      </DialogContent>
    </Dialog>
  );
}
