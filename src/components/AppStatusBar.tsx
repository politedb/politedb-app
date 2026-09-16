import { useEffect, useMemo, useState } from "preact/hooks";
import { getTelemetryConsent } from "src/lib/analytics";
import { normalizeQuerySafetyMode } from "src/lib/queries/querySafety";
import { useAppUpdater } from "src/hooks/useAppUpdater";
import { useScreenStore } from "src/stores/screen";
import { cn } from "src/utils/cn";
import { buildAppStatusBarModel, type AppStatusBarDot } from "./statusBarModel";

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
  const { appVersion } = useAppUpdater();
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
        "border-t border-slate-200 bg-slate-100 text-slate-700",
        "dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
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
      </div>

      <div class="flex min-w-0 shrink-0 items-center gap-2">
        <StatusSegments items={model.right} />
      </div>
    </footer>
  );
}
