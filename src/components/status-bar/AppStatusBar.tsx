import { useEffect, useMemo, useState } from "preact/hooks";
import { getTelemetryConsent } from "src/lib/analytics";
import { normalizeQuerySafetyMode } from "src/lib/queries/querySafety";
import { useAppUpdater } from "src/hooks/useAppUpdater";
import { useScreenStore } from "src/stores/screen";
import { cn } from "src/utils/cn";
import {
  querySafetyModeInfo,
  requestOpenSafetyModePicker,
} from "src/lib/queries/querySafetyModes";
import {
  buildAppStatusBarModel,
  querySafetyStatusLabel,
  type AppStatusBarDot,
} from "./statusBarModel";

const DOT_CLASS: Record<AppStatusBarDot, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-400",
  idle: "bg-slate-400",
};

function StatusSegments({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item, index) => (
        <span key={`${index}-${item}`} class="flex min-w-0 items-center gap-2">
          {index > 0 ? (
            <span class="shrink-0 font-normal text-sky-300">|</span>
          ) : null}
          <span class="truncate">{item}</span>
        </span>
      ))}
    </>
  );
}

export function AppStatusBar() {
  const activeProfileScreen = useScreenStore((s) => s.activeProfileScreen);
  const profileTabs = useScreenStore((s) => s.profileTabs);
  const setActiveProfileScreen = useScreenStore(
    (s) => s.setActiveProfileScreen
  );
  const { appVersion, updateAvailable, updateVersion } = useAppUpdater();
  const [telemetryConsent, setTelemetryConsent] = useState(getTelemetryConsent);

  useEffect(() => {
    const sync = () => setTelemetryConsent(getTelemetryConsent());
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const activeTab = useMemo(() => {
    if (!activeProfileScreen.startsWith("tab-")) return null;
    return profileTabs.find((tab) => tab.id === activeProfileScreen) ?? null;
  }, [activeProfileScreen, profileTabs]);

  const model = buildAppStatusBarModel({
    isConnectionTab: !!activeTab,
    label: activeTab?.label,
    engine: activeTab?.engine,
    connected: !!activeTab?.runtimeConnectionId,
    querySafetyMode: normalizeQuerySafetyMode(
      activeTab?.querySafetyMode ?? (activeTab?.isLocked ? "lock" : "default")
    ),
    appVersion,
    isDev: import.meta.env.DEV,
    telemetryConsent,
  });

  return (
    <footer
      role="contentinfo"
      class={cn(
        "flex h-8 shrink-0 items-center justify-between gap-3 px-3 text-[11px] font-medium",
        "border-t border-slate-200 bg-slate-100 text-slate-700"
      )}
    >
      <div class="flex min-w-0 items-center gap-2">
        <span
          class={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[model.dot])}
          aria-hidden="true"
        />
        <div class="flex min-w-0 items-center gap-2">
          <StatusSegments items={model.left} />
        </div>
        {model.mode ? (
          <button
            type="button"
            class={cn(
              "flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2",
              "text-[11px] leading-none font-medium transition-colors",
              "hover:brightness-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none",
              querySafetyModeInfo(model.mode).badgeClass
            )}
            title="Change the query safety mode"
            aria-label={`${querySafetyStatusLabel(model.mode)}. Change`}
            onClick={(e) => {
              e.stopPropagation();
              requestOpenSafetyModePicker();
            }}
          >
            <span
              aria-hidden="true"
              class={cn(
                "size-1.5 rounded-full",
                querySafetyModeInfo(model.mode).dotClass
              )}
            />
            {querySafetyModeInfo(model.mode).shortLabel}
          </button>
        ) : null}
      </div>

      <div class="flex min-w-0 shrink-0 items-center gap-2">
        {updateAvailable && updateVersion ? (
          <button
            type="button"
            class="shrink-0 rounded px-1 font-medium text-blue-700 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:text-blue-300"
            title="Install it from the Databases screen"
            onClick={() => setActiveProfileScreen("main")}
          >
            Update available: v{updateVersion}
          </button>
        ) : null}
        <StatusSegments items={model.right} />
      </div>
    </footer>
  );
}
